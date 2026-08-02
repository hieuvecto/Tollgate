FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o /baseline .
FROM scratch
COPY --from=build /baseline /baseline
EXPOSE 3010
ENTRYPOINT ["/baseline"]

