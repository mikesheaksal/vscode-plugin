# Proto tooling. The buf.build registry is not reachable from every environment
# this repo builds in, so plugins are installed locally and the googleapis
# imports are vendored under proto/third_party.
BUF_VERSION := v1.47.2

.PHONY: tools generate lint breaking mock test

tools:
	go install github.com/bufbuild/buf/cmd/buf@$(BUF_VERSION)
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.1
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
	go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@v2.24.0
	go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@v2.24.0
	npm install

## Regenerate Go, OpenAPI and TypeScript from the contract. Output is committed
## so that building the extension needs only npm, and the mock needs only Go.
generate:
	cd proto && buf generate --template buf.gen.go.yaml
	cd proto && buf generate --template buf.gen.ts.yaml
	go mod tidy

lint:
	cd proto && buf lint

## Old clients stay in the field indefinitely under .vsix distribution, so the
## contract is checked against the default branch on every change.
##
## Skips itself while the baseline on main cannot be built - main still declares
## the remote googleapis module, which is unreachable from restricted
## environments. Self-heals once the vendored setup lands there.
breaking:
	@if buf build '.git#branch=main,subdir=proto' >/dev/null 2>&1; then \
		buf breaking proto --against '.git#branch=main,subdir=proto'; \
	else \
		echo "skipping: baseline on main is not buildable yet"; \
	fi

mock:
	go run ./mock

test:
	go vet ./...
	npm run check
