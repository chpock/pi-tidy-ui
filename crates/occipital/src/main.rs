//! One persistent owned helper, or the same engine hosted by a user-managed supervisor.
use occipital::{
    actor::ActorPool, catalogue::Catalogue, control::Authority, protocol::Fault,
    semantic_engine::Limits,
};
use std::{path::PathBuf, sync::Arc, time::Duration};
enum Mode {
    Stdio,
    Shared,
}
fn arguments(
    input: impl IntoIterator<Item = std::ffi::OsString>,
) -> Result<(Mode, Option<PathBuf>), Fault> {
    let mut args = input.into_iter();
    let mut mode = None;
    let mut config = None;
    while let Some(arg) = args.next() {
        if arg == "--stdio" || arg == "--subc" {
            if mode.is_some() {
                return Err(Fault::not_started("arguments"));
            }
            mode = Some(if arg == "--stdio" {
                Mode::Stdio
            } else {
                // Consume and validate the supervisor's public SDK argument;
                // the SDK remains responsible for reading that connection file.
                let connection = args.next().ok_or(Fault::not_started("arguments"))?;
                if connection.is_empty() {
                    return Err(Fault::not_started("arguments"));
                }
                Mode::Shared
            });
        } else if arg == "--config" {
            if config.is_some() {
                return Err(Fault::not_started("arguments"));
            }
            config = Some(PathBuf::from(
                args.next().ok_or(Fault::not_started("arguments"))?,
            ));
        } else if arg == "--version" {
            println!("occipital {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        } else if arg == "--help" {
            println!("occipital [--stdio | --subc CONNECTION_FILE] [--config FILE]\n\nDefault: persistent framed stdin/stdout helper.\nShared mode requires an explicitly configured user-managed Subconscious module.");
            std::process::exit(0);
        } else {
            return Err(Fault::not_started("arguments"));
        }
    }
    Ok((mode.unwrap_or(Mode::Stdio), config))
}
async fn run(mode: Mode, config: Option<PathBuf>) -> Result<(), Fault> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| Fault::not_started("instance"))?;
    let instance = format!("occipital-{:032x}", u128::from_be_bytes(nonce));
    let workers = match mode {
        Mode::Stdio => 1,
        Mode::Shared => std::thread::available_parallelism().map_or(1, |n| n.get().min(2)),
    };
    let limits = Limits::default();
    let pool = ActorPool::with_limits(instance.clone(), workers, limits.clone())?;
    let authority = Arc::new(Authority::new(
        pool.handle(),
        instance,
        limits,
        Catalogue::new(config),
    )?);
    let result = match mode {
        Mode::Stdio => {
            let route = pool.bind().await?;
            tokio::select! {
                result = occipital::stdio::run(Arc::clone(&authority), route) => result,
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
        Mode::Shared => {
            tokio::select! {
                result = occipital::shared::run(Arc::clone(&authority), pool.handle()) => result,
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
    };
    authority.retire();
    let stopped = pool.shutdown().await;
    result.and(stopped)
}
fn main() {
    let result = (|| {
        let (mode, config) = arguments(std::env::args_os().skip(1))?;
        if matches!(mode, Mode::Shared) {
            // Cache and close the inherited SDK launch descriptor before creating
            // runtime sockets or parser threads. SDK HELLO reuses its cached value.
            subc_client_rs::launch_nonce().map_err(|_| Fault::not_started("shared_launch"))?;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("occipital-io")
            .enable_all()
            .build()
            .map_err(|_| Fault::not_started("runtime"))?;
        let result = runtime.block_on(run(mode, config));
        // An abandoned bounded catalogue read need not keep the owned process
        // alive. Parser workers have their separate cooperative stop above.
        runtime.shutdown_timeout(Duration::from_millis(200));
        result
    })();
    if let Err(fault) = result {
        // No OS/socket/authentication errors or source text on either pipe.
        eprintln!("occipital stopped: {}", fault.code);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: &[&str]) -> Result<(Mode, Option<PathBuf>), Fault> {
        arguments(args.iter().map(std::ffi::OsString::from))
    }
    #[test]
    fn public_sdk_launch_arguments_select_shared_without_becoming_native_configuration() {
        let (mode, config) = parse(&[
            "--subc",
            "isolated/connection.json",
            "--config",
            "isolated/themes.json",
        ])
        .unwrap();
        assert!(matches!(mode, Mode::Shared));
        assert_eq!(config, Some(PathBuf::from("isolated/themes.json")));
        let (mode, config) = parse(&[
            "--config",
            "isolated/themes.json",
            "--subc",
            "isolated/connection.json",
        ])
        .unwrap();
        assert!(matches!(mode, Mode::Shared));
        assert_eq!(config, Some(PathBuf::from("isolated/themes.json")));
    }
    #[test]
    fn standalone_is_default_and_mixed_duplicate_or_missing_launch_values_are_rejected() {
        assert!(matches!(parse(&[]).unwrap().0, Mode::Stdio));
        assert!(matches!(parse(&["--stdio"]).unwrap().0, Mode::Stdio));
        for args in [
            vec!["--subc"],
            vec!["--subc", ""],
            vec!["--stdio", "--subc", "connection"],
            vec!["--subc", "connection", "--stdio"],
            vec!["--subc", "first", "--subc", "second"],
        ] {
            assert!(parse(&args).is_err());
        }
    }
}
