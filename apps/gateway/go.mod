module kraken/apps/gateway

go 1.26.1

require (
	connectrpc.com/connect v1.19.1
	github.com/joho/godotenv v1.5.1
	kraken/gen/go v0.0.0
)

require google.golang.org/protobuf v1.36.9 // indirect

replace kraken/gen/go => ../../gen/go
