.PHONY: install dev dev-minis test typecheck build verify package package-sandbox package-production

install:
	npm ci

dev:
	npm run dev

dev-minis:
	npm run dev:minis

test:
	npm test

typecheck:
	npm run typecheck

build:
	npm run build:web

verify: test typecheck build

package: package-production

package-sandbox:
	@test -n "$(APP)" || (echo "APP=<tiktok-app-id> is required for Sandbox packaging."; exit 1)
	npm run build -- --app $(APP) --deployment sandbox

package-production:
	npm run build -- $(if $(APP),--app $(APP),) --deployment production
