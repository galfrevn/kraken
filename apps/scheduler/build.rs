fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(
            &[
                "../../proto/agent/v1/common.proto",
                "../../proto/agent/v1/scheduler.proto",
                "../../proto/agent/v1/gateway.proto",
                "../../proto/agent/v1/worker.proto",
                "../../proto/agent/v1/daemon.proto",
            ],
            &["../../proto"],
        )?;
    Ok(())
}
