use std::{
    collections::BTreeMap,
    io::{BufReader, BufWriter},
    os::unix::net::UnixStream,
    process::ExitCode,
    time::Duration,
};

use clap::{Parser, Subcommand, ValueEnum};
use dashboardd_desktop_control::{
    Command, Outcome, PROTOCOL_VERSION, Presentation, Request, Response, read_message, socket_path,
    write_message,
};
use serde::de::DeserializeOwned;

const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Parser)]
#[command(about = "Control the resident dashboardd desktop service")]
struct Cli {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliPresentation {
    Focus,
    Tile,
}

impl From<CliPresentation> for Presentation {
    fn from(value: CliPresentation) -> Self {
        match value {
            CliPresentation::Focus => Self::Focus,
            CliPresentation::Tile => Self::Tile,
        }
    }
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// List installed widgets and their opening contracts.
    Discover,
    /// Open a new native widget surface.
    Open {
        /// Installed widget identifier.
        widget_id: String,
        /// Explicit widget variant identifier.
        #[arg(long)]
        variant: String,
        /// JSON object containing supplied option values.
        #[arg(long, default_value = "{}")]
        options: String,
        /// JSON object containing direct typed-input envelopes.
        #[arg(long, default_value = "{}")]
        inputs: String,
        /// Initial widget presentation.
        #[arg(long, value_enum, default_value = "focus")]
        presentation: CliPresentation,
    },
    /// Replace mutable fields on one surface.
    Update {
        /// Surface identifier returned by open.
        surface_id: String,
        /// Replacement JSON direct-input map.
        #[arg(long)]
        inputs: Option<String>,
        /// Replacement widget presentation.
        #[arg(long, value_enum)]
        presentation: Option<CliPresentation>,
    },
    /// List open surfaces.
    List,
    /// Focus an open surface.
    Focus {
        /// Surface identifier returned by open.
        surface_id: String,
    },
    /// Close an open surface.
    Close {
        /// Surface identifier returned by open.
        surface_id: String,
    },
    /// Shut down the resident desktop service.
    Quit,
}

fn main() -> ExitCode {
    let command = match command(Cli::parse().command) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("dashboardctl: {error}");
            return ExitCode::from(2);
        }
    };
    match run(command) {
        Ok(response) => {
            let mut stdout = BufWriter::new(std::io::stdout().lock());
            if let Err(error) = write_message(&mut stdout, &response) {
                eprintln!("dashboardctl: {error}");
                return ExitCode::from(2);
            }
            match response.outcome {
                Outcome::Ok { .. } => ExitCode::SUCCESS,
                Outcome::Failed { .. } => ExitCode::from(1),
            }
        }
        Err(error) => {
            eprintln!("dashboardctl: {error}");
            ExitCode::from(2)
        }
    }
}

fn command(command: CliCommand) -> Result<Command, String> {
    Ok(match command {
        CliCommand::Discover => Command::Discover,
        CliCommand::Open {
            widget_id,
            variant,
            options,
            inputs,
            presentation,
        } => Command::Open {
            widget_id,
            variant_id: variant,
            options: parse_map("options", &options)?,
            inputs: parse_map("inputs", &inputs)?,
            presentation: presentation.into(),
        },
        CliCommand::Update {
            surface_id,
            inputs,
            presentation,
        } => Command::Update {
            surface_id,
            inputs: inputs
                .as_deref()
                .map(|value| parse_map("inputs", value))
                .transpose()?,
            presentation: presentation.map(Into::into),
        },
        CliCommand::List => Command::List,
        CliCommand::Focus { surface_id } => Command::Focus { surface_id },
        CliCommand::Close { surface_id } => Command::Close { surface_id },
        CliCommand::Quit => Command::Quit,
    })
}

fn parse_map<T: DeserializeOwned>(name: &str, value: &str) -> Result<BTreeMap<String, T>, String> {
    serde_json::from_str(value).map_err(|error| format!("invalid {name} JSON object: {error}"))
}

fn run(command: Command) -> Result<Response, String> {
    let path = socket_path().map_err(|error| error.to_string())?;
    let stream = UnixStream::connect(&path)
        .map_err(|error| format!("cannot connect to {}: {error}", path.display()))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("cannot set read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("cannot set write timeout: {error}"))?;

    write_message(
        &mut BufWriter::new(&stream),
        &Request {
            version: PROTOCOL_VERSION,
            command,
        },
    )
    .map_err(|error| error.to_string())?;
    read_message(&mut BufReader::new(&stream)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typed_open_maps() {
        let command = command(CliCommand::Open {
            widget_id: "cpu".into(),
            variant: "full".into(),
            options: r#"{"history_points":40}"#.into(),
            inputs: r#"{"task":{"type":"task/v1","value":{"id":"one"}}}"#.into(),
            presentation: CliPresentation::Focus,
        })
        .unwrap();
        let Command::Open {
            options, inputs, ..
        } = command
        else {
            panic!("expected open command");
        };
        assert_eq!(options["history_points"], serde_json::Value::from(40));
        assert_eq!(inputs["task"].input_type, "task/v1");
    }
}
