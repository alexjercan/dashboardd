use crate::{Status, Task};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Compare {
        field: Field,
        operator: Operator,
        value: Value,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Status,
    Tags,
    Priority,
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Eq,
    In,
    Contains,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Identifier(String),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Field(String),
    Identifier(String),
    Eq,
    In,
    Contains,
    And,
    Or,
    Not,
    LeftParen,
    RightParen,
    LeftBracket,
    RightBracket,
    Comma,
    End,
}

pub fn compile(source: &str) -> Result<Option<Expr>, String> {
    if source.trim().is_empty() {
        return Ok(None);
    }
    let tokens = lex(source)?;
    let mut parser = Parser { tokens, index: 0 };
    let expression = parser.parse_or()?;
    if parser.current() != &Token::End {
        return Err("unexpected token after filter expression".into());
    }
    validate(&expression)?;
    Ok(Some(expression))
}

pub fn evaluate(expression: &Expr, task: &Task) -> bool {
    match expression {
        Expr::And(left, right) => evaluate(left, task) && evaluate(right, task),
        Expr::Or(left, right) => evaluate(left, task) || evaluate(right, task),
        Expr::Not(inner) => !evaluate(inner, task),
        Expr::Compare {
            field,
            operator,
            value,
        } => evaluate_comparison(*field, *operator, value, task),
    }
}

fn evaluate_comparison(field: Field, operator: Operator, value: &Value, task: &Task) -> bool {
    match (field, operator, value) {
        (Field::Status, Operator::Eq, Value::Identifier(value)) => task.status.as_str() == value,
        (Field::Status, Operator::In, Value::List(values)) => {
            values.iter().any(|value| task.status.as_str() == value)
        }
        (Field::Tags, Operator::Contains, Value::Identifier(value)) => {
            task.tags.iter().any(|tag| tag == value)
        }
        (Field::Priority, Operator::Eq, Value::Identifier(value)) => {
            value.parse::<u32>() == Ok(task.priority)
        }
        (Field::Title, Operator::Eq, Value::Identifier(value)) => task.title == *value,
        (Field::Title, Operator::Contains, Value::Identifier(value)) => task.title.contains(value),
        _ => false,
    }
}

fn validate(expression: &Expr) -> Result<(), String> {
    match expression {
        Expr::And(left, right) | Expr::Or(left, right) => {
            validate(left)?;
            validate(right)
        }
        Expr::Not(inner) => validate(inner),
        Expr::Compare {
            field,
            operator,
            value,
        } => validate_comparison(*field, *operator, value),
    }
}

fn validate_comparison(field: Field, operator: Operator, value: &Value) -> Result<(), String> {
    let identifier = matches!(value, Value::Identifier(_));
    let list = matches!(value, Value::List(_));
    let valid = match (field, operator) {
        (Field::Status, Operator::Eq) => identifier && valid_status_value(value),
        (Field::Status, Operator::In) => list && valid_status_value(value),
        (Field::Tags, Operator::Contains) => identifier,
        (Field::Priority, Operator::Eq) => match value {
            Value::Identifier(value) => value.parse::<u32>().is_ok(),
            Value::List(_) => false,
        },
        (Field::Title, Operator::Eq | Operator::Contains) => identifier,
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| "operator is not valid for the selected field or value".into())
}

fn valid_status_value(value: &Value) -> bool {
    match value {
        Value::Identifier(value) => Status::parse(value).is_some(),
        Value::List(values) => values.iter().all(|value| Status::parse(value).is_some()),
    }
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        while self.current() == &Token::Or {
            self.advance();
            left = Expr::Or(Box::new(left), Box::new(self.parse_and()?));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        while self.current() == &Token::And {
            self.advance();
            left = Expr::And(Box::new(left), Box::new(self.parse_unary()?));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        if self.current() == &Token::Not {
            self.advance();
            return Ok(Expr::Not(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        if self.current() == &Token::LeftParen {
            self.advance();
            let expression = self.parse_or()?;
            self.require(Token::RightParen)?;
            return Ok(expression);
        }
        self.parse_comparison()
    }

    fn parse_comparison(&mut self) -> Result<Expr, String> {
        let Token::Field(name) = self.current().clone() else {
            return Err("comparison must start with a field".into());
        };
        self.advance();
        let field = match name.as_str() {
            "status" => Field::Status,
            "tags" => Field::Tags,
            "priority" => Field::Priority,
            "title" => Field::Title,
            _ => return Err(format!("unknown field {name:?}")),
        };
        let operator = match self.current() {
            Token::Eq => Operator::Eq,
            Token::In => Operator::In,
            Token::Contains => Operator::Contains,
            _ => return Err("field must be followed by eq, in, or contains".into()),
        };
        self.advance();
        let value = match self.current().clone() {
            Token::Identifier(value) => {
                self.advance();
                Value::Identifier(value)
            }
            Token::LeftBracket => self.parse_list()?,
            _ => return Err("comparison requires an identifier or list".into()),
        };
        Ok(Expr::Compare {
            field,
            operator,
            value,
        })
    }

    fn parse_list(&mut self) -> Result<Value, String> {
        self.require(Token::LeftBracket)?;
        let mut values = Vec::new();
        if self.current() == &Token::RightBracket {
            self.advance();
            return Ok(Value::List(values));
        }
        loop {
            let Token::Identifier(value) = self.current().clone() else {
                return Err("filter list requires identifiers".into());
            };
            values.push(value);
            self.advance();
            if self.current() == &Token::RightBracket {
                self.advance();
                break;
            }
            self.require(Token::Comma)?;
        }
        Ok(Value::List(values))
    }

    fn require(&mut self, token: Token) -> Result<(), String> {
        if self.current() != &token {
            return Err(format!("expected {token:?}"));
        }
        self.advance();
        Ok(())
    }

    fn current(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn advance(&mut self) {
        self.index += 1;
    }
}

fn lex(source: &str) -> Result<Vec<Token>, String> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        let token = match bytes[index] {
            b'(' => single(&mut index, Token::LeftParen),
            b')' => single(&mut index, Token::RightParen),
            b'[' => single(&mut index, Token::LeftBracket),
            b']' => single(&mut index, Token::RightBracket),
            b',' => single(&mut index, Token::Comma),
            b':' => {
                index += 1;
                let start = index;
                if index >= bytes.len()
                    || !(bytes[index].is_ascii_alphabetic() || bytes[index] == b'_')
                {
                    return Err("invalid filter field".into());
                }
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                Token::Field(source[start..index].into())
            }
            byte if byte.is_ascii_alphanumeric() || byte == b'_' => {
                let start = index;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric()
                        || matches!(bytes[index], b'_' | b'.' | b'-'))
                {
                    index += 1;
                }
                match &source[start..index] {
                    "eq" => Token::Eq,
                    "in" => Token::In,
                    "contains" => Token::Contains,
                    "and" => Token::And,
                    "or" => Token::Or,
                    "not" => Token::Not,
                    value => Token::Identifier(value.into()),
                }
            }
            _ => return Err(format!("invalid filter token at byte {}", index + 1)),
        };
        tokens.push(token);
    }
    tokens.push(Token::End);
    Ok(tokens)
}

fn single(index: &mut usize, token: Token) -> Token {
    *index += 1;
    token
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Task {
        Task {
            id: "20260814-120000".into(),
            project_id: "project-test".into(),
            project: "scufris".into(),
            worktree_id: "worktree-test".into(),
            worktree: "Primary".into(),
            title: "Add task widget".into(),
            status: Status::InProgress,
            priority: 100,
            tags: vec!["widget".into(), "rust".into()],
        }
    }

    #[test]
    fn evaluates_tatr_filter_operators_and_precedence() {
        let expression = compile(
            "(:status in [OPEN, IN_PROGRESS]) and (:tags contains widget) or :priority eq 2",
        )
        .unwrap()
        .unwrap();

        assert!(evaluate(&expression, &task()));
        assert!(!evaluate(
            &compile("not (:title contains task)").unwrap().unwrap(),
            &task()
        ));
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_operator_types() {
        assert!(compile(":project eq scufris").is_err());
        assert!(compile(":tags in [widget]").is_err());
        assert!(compile(":status eq MAYBE").is_err());
        assert!(compile(":priority eq high").is_err());
    }
}
