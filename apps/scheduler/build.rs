fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(
            &[
                "../../proto/agent/v1/common.proto",
                "../../proto/agent/v1/scheduler.proto",
            ],
            &["../../proto"],
        )?;
    Ok(())
}
