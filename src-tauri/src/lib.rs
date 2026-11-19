pub mod commands;
pub mod config;
pub mod error;
pub mod pty;
pub mod sftp;
pub mod ssh;
pub mod sync;

use std::fs::OpenOptions;
use std::sync::{Arc, Mutex};

use tauri::{Manager, PhysicalPosition, PhysicalSize, RunEvent, WindowEvent};
use tracing_subscriber::EnvFilter;

use commands::AppState;
use config::{ConfigStore, WindowGeometry};
use pty::PtyManager;
use sftp::{SftpManager, TransferManager};
use ssh::SshManager;
use sync::SyncManager;

fn init_logging(logs_dir: &std::path::Path) {
    let log_file_path = logs_dir.join("labbridge.log");
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,russh=warn"));

    if let Ok(file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path)
    {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_ansi(false)
            .with_writer(Mutex::new(file))
            .try_init();
    } else {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .try_init();
    }
}

fn capture_window_geometry(window: &tauri::Window, config: &ConfigStore) {
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        if let Ok(existing) = config.get_ui_state() {
            if let Some(mut prev) = existing.window {
                prev.maximized = true;
                let _ = config.save_window_geometry(prev);
                return;
            }
        }
    }

    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
        if size.width >= 640 && size.height >= 420 {
            let _ = config.save_window_geometry(WindowGeometry {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                maximized,
            });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_store =
        ConfigStore::initialize().expect("Failed to initialize LabBridge storage directory");
    init_logging(config_store.logs_dir());

    tracing::info!(
        "LabBridge starting (portable={}, data_dir={})",
        config_store.storage_info().is_portable,
        config_store.storage_info().data_dir
    );

    let ssh_manager = SshManager::new(Arc::clone(&config_store));
    let pty_manager = PtyManager::new(Arc::clone(&ssh_manager));
    let sftp_manager = SftpManager::new(Arc::clone(&ssh_manager));
    let transfer_manager = TransferManager::new(Arc::clone(&sftp_manager));
    let sync_manager = SyncManager::new(
        Arc::clone(&config_store),
        Arc::clone(&ssh_manager),
        Arc::clone(&sftp_manager),
    );

    // Coordinate post-reconnect recovery: recreate SFTP subsystem + delta reconcile offline edits
    let (reconn_tx, mut reconn_rx) =
        tokio::sync::mpsc::unbounded_channel::<(tauri::AppHandle, String)>();
    {
        let ssh_for_notifier = Arc::clone(&ssh_manager);
        tauri::async_runtime::block_on(async move {
            ssh_for_notifier.set_reconnect_notifier(reconn_tx).await;
        });
    }
    {
        let sftp_for_reconn = Arc::clone(&sftp_manager);
        let sync_for_reconn = Arc::clone(&sync_manager);
        let cfg_for_reconn = Arc::clone(&config_store);
        tauri::async_runtime::spawn(async move {
            while let Some((app_handle, profile_id)) = reconn_rx.recv().await {
                sftp_for_reconn.invalidate(&profile_id).await;
                let _ = sftp_for_reconn.get_or_create(&profile_id).await;

                if let Ok(profile) = cfg_for_reconn.get_profile(&profile_id) {
                    if profile.auto_sync_enabled
                        && !profile.local_root_path.trim().is_empty()
                        && !profile.remote_root_path.trim().is_empty()
                    {
                        let _ = sync_for_reconn
                            .reconcile_workspace(&app_handle, &profile_id, false)
                            .await;
                    }
                }
            }
        });
    }

    let app_state = AppState {
        config: Arc::clone(&config_store),
        ssh: Arc::clone(&ssh_manager),
        pty: pty_manager,
        sftp: sftp_manager,
        transfers: transfer_manager,
        sync: Arc::clone(&sync_manager),
    };

    let setup_cfg = Arc::clone(&config_store);
    let win_event_cfg = Arc::clone(&config_store);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            if let Some(main_win) = app.get_webview_window("main") {
                if let Ok(ui_state) = setup_cfg.get_ui_state() {
                    if let Some(geom) = ui_state.window {
                        if geom.width >= 640 && geom.height >= 420 {
                            let _ = main_win.set_size(PhysicalSize::new(geom.width, geom.height));
                        }
                        if geom.x > -10_000 && geom.y > -10_000 {
                            let _ = main_win.set_position(PhysicalPosition::new(geom.x, geom.y));
                        }
                        if geom.maximized {
                            let _ = main_win.maximize();
                        }
                    }
                }
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Resized(_)
                | WindowEvent::Moved(_)
                | WindowEvent::CloseRequested { .. } => {
                    capture_window_geometry(window, &win_event_cfg);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::storage_get_info,
            commands::profiles_list,
            commands::profile_save,
            commands::profile_duplicate,
            commands::profile_delete,
            commands::profile_secret_status,
            commands::profile_update_macros,
            commands::known_hosts_list,
            commands::known_hosts_remove,
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::ssh_get_state,
            commands::ssh_list_states,
            commands::ssh_respond_host_key,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
            commands::fs_local_list_dir,
            commands::fs_local_create_dir,
            commands::fs_local_rename,
            commands::fs_local_delete,
            commands::sftp_list_dir,
            commands::sftp_create_dir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_chmod,
            commands::transfer_subscribe,
            commands::transfer_enqueue,
            commands::transfer_cancel,
            commands::transfer_list,
            commands::transfer_clear_finished,
            commands::compare_file_hashes,
            commands::diff_read_contents,
            commands::open_in_vscode,
            commands::reconcile_workspace,
            commands::sync_get_status,
            commands::sync_update_policy,
            commands::sync_retry,
            commands::sync_flush_pending,
            commands::sync_get_activity_log,
            commands::sync_clear_activity_log,
            commands::ui_state_get,
            commands::ui_state_save,
        ])
        .build(tauri::generate_context!())
        .expect("error while building LabBridge application");

    app.run(move |app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<AppState>();
            let sync = Arc::clone(&state.sync);
            let ssh = Arc::clone(&state.ssh);
            tauri::async_runtime::block_on(async move {
                sync.stop_all().await;
                ssh.disconnect_all().await;
            });
        }
    });
}
