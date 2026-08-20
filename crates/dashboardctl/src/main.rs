use std::{
    io::{BufReader, BufWriter},
    os::unix::net::UnixStream,
    process::ExitCode,
    time::Duration,
};

use clap::{Parser, Subcommand};
use dashboardd_desktop_control::{
    Command, Outcome, PROTOCOL_VERSION, Request, Response, read_message, socket_path, write_message,
};

const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Parser)]
#[command(about = "Control the resident dashboardd desktop service")]
struct Cli {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Open a new static lifecycle demo window.
    OpenDemo {
        /// Native window title.
        #[arg(long)]
        title: Option<String>,
    },
    /// List open surfaces.
    List,
    /// Focus an open surface.
    Focus {
        /// Surface identifier returned by open-demo.
        surface_id: String,
    },
    /// Close an open surface.
    Close {
        /// Surface identifier returned by open-demo.
        surface_id: String,
    },
}

impl From<CliCommand> for Command {
    fn from(command: CliCommand) -> Self {
        match command {
            CliCommand::OpenDemo { title } => Self::OpenDemo { title },
            CliCommand::List => Self::List,
            CliCommand::Focus { surface_id } => Self::Focus { surface_id },
            CliCommand::Close { surface_id } => Self::Close { surface_id },
        }
    }
}

fn main() -> ExitCode {
    match run(Cli::parse().command.into()) {
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
