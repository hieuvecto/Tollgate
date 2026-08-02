FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod *.go ./
RUN go test ./... && CGO_ENABLED=0 go build -o /baseline .
FROM scratch
COPY --from=build /baseline /baseline
EXPOSE 3010
ENTRYPOINT ["/baseline"]
