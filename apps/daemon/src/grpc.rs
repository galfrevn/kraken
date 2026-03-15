use std::sync::Arc;
use tokio::sync::broadcast;
use tonic::{Request, Response, Status};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::cron::CronEngine;
use crate::watcher::FileWatcherEngine;
use crate::proto::agent::v1::{
    scheduler_service_server::SchedulerService,
    RegisterCronRequest, RegisterCronResponse,
    UnregisterCronRequest, UnregisterCronResponse,
    ListCronsRequest, ListCronsResponse,
    RegisterWatcherRequest, RegisterWatcherResponse,
    UnregisterWatcherRequest, UnregisterWatcherResponse,
    ListWatchersRequest, ListWatchersResponse,
    StreamEventsRequest, StreamEventsResponse,
    SchedulerEvent,
};

pub struct SchedulerServer {
    cron_engine: Arc<CronEngine>,
    watcher_engine: Arc<FileWatcherEngine>,
    event_sender: broadcast::Sender<SchedulerEvent>,
}

impl SchedulerServer {
    pub fn new(
        cron_engine: Arc<CronEngine>,
        watcher_engine: Arc<FileWatcherEngine>,
        event_sender: broadcast::Sender<SchedulerEvent>,
    ) -> Self {
        Self {
            cron_engine,
            watcher_engine,
            event_sender,
        }
    }
}

#[tonic::async_trait]
impl SchedulerService for SchedulerServer {
    async fn register_cron(
        &self,
        request: Request<RegisterCronRequest>,
    ) -> Result<Response<RegisterCronResponse>, Status> {
        let req = request.into_inner();
        let params = req.parameters.into_iter().collect();

        match self.cron_engine.register(req.name, &req.cron_expression, req.task_template, params) {
            Ok((cron_id, next_run)) => Ok(Response::new(RegisterCronResponse { cron_id, next_run })),
            Err(e) => Err(Status::invalid_argument(e)),
        }
    }

    async fn unregister_cron(
        &self,
        request: Request<UnregisterCronRequest>,
    ) -> Result<Response<UnregisterCronResponse>, Status> {
        let req = request.into_inner();
        if self.cron_engine.unregister(&req.cron_id) {
            Ok(Response::new(UnregisterCronResponse {}))
        } else {
            Err(Status::not_found("cron job not found"))
        }
    }

    async fn list_crons(
        &self,
        _request: Request<ListCronsRequest>,
    ) -> Result<Response<ListCronsResponse>, Status> {
        let crons = self.cron_engine.list();
        Ok(Response::new(ListCronsResponse { crons }))
    }

    async fn register_watcher(
        &self,
        request: Request<RegisterWatcherRequest>,
    ) -> Result<Response<RegisterWatcherResponse>, Status> {
        let req = request.into_inner();

        match self.watcher_engine.register(req.name, req.paths, req.ignore_patterns, req.debounce_ms) {
            Ok(watcher_id) => Ok(Response::new(RegisterWatcherResponse { watcher_id })),
            Err(e) => Err(Status::internal(e)),
        }
    }

    async fn unregister_watcher(
        &self,
        request: Request<UnregisterWatcherRequest>,
    ) -> Result<Response<UnregisterWatcherResponse>, Status> {
        let req = request.into_inner();
        if self.watcher_engine.unregister(&req.watcher_id) {
            Ok(Response::new(UnregisterWatcherResponse {}))
        } else {
            Err(Status::not_found("watcher not found"))
        }
    }

    async fn list_watchers(
        &self,
        _request: Request<ListWatchersRequest>,
    ) -> Result<Response<ListWatchersResponse>, Status> {
        let watchers = self.watcher_engine.list();
        Ok(Response::new(ListWatchersResponse { watchers }))
    }

    type StreamEventsStream = std::pin::Pin<
        Box<dyn tokio_stream::Stream<Item = Result<StreamEventsResponse, Status>> + Send>,
    >;

    async fn stream_events(
        &self,
        _request: Request<StreamEventsRequest>,
    ) -> Result<Response<Self::StreamEventsStream>, Status> {
        let rx = self.event_sender.subscribe();
        let stream = BroadcastStream::new(rx).filter_map(|result| match result {
            Ok(event) => Some(Ok(StreamEventsResponse {
                event: Some(event),
            })),
            Err(_) => None,
        });

        Ok(Response::new(Box::pin(stream)))
    }
}
