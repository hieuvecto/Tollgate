.PHONY: up down migrate seed test chaos load reconcile logs
export DATABASE_URL ?= postgres://tollgate:tollgate@localhost:5432/tollgate
export REDIS_URL ?= redis://localhost:56379
up:
	docker compose up --build -d
down:
	docker compose down
migrate:
	docker compose run --rm migrate
seed:
	docker compose run --rm migrate node packages/db/dist/seed.js
test:
	pnpm lint && pnpm typecheck && RUN_INTEGRATION=1 pnpm test
chaos:
	pnpm test:chaos
load:
	docker compose --profile load run --rm k6
reconcile:
	docker compose exec worker node packages/worker/dist/reconcile-once.js
logs:
	docker compose logs -f gateway control-plane worker mock-provider
