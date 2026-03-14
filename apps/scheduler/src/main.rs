mod proto;
mod cron;
mod watcher;
mod grpc;
mod db;

use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::signal;
use tonic::transport::Server;
use tracing::info;
use tracing_subscriber::EnvFilter;

use proto::agent::v1::scheduler_service_server::SchedulerServiceServer;

const DEFAULT_PORT: u16 = 50051;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("scheduler=info".parse()?))
        .init();

    let port = std::env::var("SCHEDULER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let addr = format!("0.0.0.0:{port}").parse()?;

    let (event_tx, _) = broadcast::channel(1024);

    let cron_engine = Arc::new(cron::CronEngine::new(event_tx.clone()));
    cron_engine.start();

    let watcher_engine = Arc::new(watcher::FileWatcherEngine::new(event_tx.clone()));

    let scheduler_server = grpc::SchedulerServer::new(
        cron_engine.clone(),
        watcher_engine,
        event_tx,
    );

    info!(port = port, "scheduler service starting");

    Server::builder()
        .add_service(SchedulerServiceServer::new(scheduler_server))
        .serve_with_shutdown(addr, async {
            signal::ctrl_c().await.ok();
            info!("received shutdown signal");
        })
        .await?;

    cron_engine.shutdown();
    info!("scheduler stopped");

    Ok(())
}
