use std::{env, error::Error, path::PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("dashboardd-widget: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [help] if help == "--help" || help == "-h" => {
            println!("{}", usage());
            Ok(())
        }
        [command, bundle] if command == "check" => {
            let checked = dashboardd_widget_bundle::check_bundle(&PathBuf::from(bundle))?;
            println!(
                "checked {} in {}",
                checked.manifest.id,
                checked.directory.display()
            );
            Ok(())
        }
        [command, manifest, output_flag, output]
            if command == "pack" && output_flag == "--output" =>
        {
            let checked =
                dashboardd_widget_bundle::pack(&PathBuf::from(manifest), &PathBuf::from(output))?;
            println!(
                "packed {} in {}",
                checked.manifest.id,
                checked.directory.display()
            );
            Ok(())
        }
        _ => Err(usage().into()),
    }
}

fn usage() -> &'static str {
    "usage:\n  dashboardd-widget pack <widget.toml> --output <bundle>\n  dashboardd-widget check <bundle>"
}
