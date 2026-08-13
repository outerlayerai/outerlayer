# Dashboards — Acceptance Criteria

Creating and editing dashboards, widgets and their data queries, permission-based visibility, and tenancy for the dashboards domain.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Creating and editing dashboards

1. `AC-063-01` **Given** a user creates a dashboard from a template, **When** the dashboard is saved, **Then** every template widget is created and placed on the grid layout.
2. `AC-063-02` **Given** an app already has a dashboard with a given name, **When** a user creates or renames another dashboard to that same name (any letter case), **Then** the request is rejected as a duplicate.
3. `AC-063-03` **Given** an app is at its maximum number of dashboards, **When** a user tries to create one more, **Then** the request is rejected.
4. `AC-063-04` **Given** a user updates only some fields of a dashboard, **When** the update is saved, **Then** the unspecified fields keep their prior values.
5. `AC-063-05` **Given** a dashboard has widgets, **When** the dashboard is deleted, **Then** its widgets are deleted with it.
6. `AC-063-06` **Given** a user duplicates a dashboard, **When** the copy is created, **Then** it has its own copies of every widget and its own layout referencing only those new widgets, and the source dashboard is unchanged.
7. `AC-063-07` **Given** a dashboard is marked as an app's default, **When** a user sets a different dashboard as the default, **Then** exactly one dashboard is the default afterward, never two.

## Widgets and their data queries

8. `AC-063-08` **Given** a dashboard already has a widget with a given title, **When** a user adds another widget with that same title (any letter case), **Then** the request is rejected as a duplicate.
9. `AC-063-09` **Given** a dashboard is at its maximum number of widgets, **When** a user tries to add one more, **Then** the request is rejected.
10. `AC-063-10` **Given** trace data exists for an app, **When** a widget's data query runs, **Then** the returned numbers match the underlying data, scoped to the requesting tenant and app.
11. `AC-063-11` **Given** a widget uses a derived metric or a custom metadata field, **When** the widget is added, **Then** the tenant must hold the custom-metrics entitlement, or the request is denied.

## Permission-based visibility

12. `AC-063-12` **Given** a user holds only the read permission on a dashboard, **When** they attempt to create, rename, update, or delete a dashboard or widget, **Then** every one of those attempts is denied while they can still view the dashboard.

## Tenancy

13. `AC-063-13` **Given** two organizations each have their own dashboards and widgets, **When** a member of one organization reads dashboards (including by probing another organization's dashboard id directly), **Then** they see only their own organization's dashboards and widgets, never the other's.

## Empty and error states

14. `AC-063-14` **Given** the dashboard list fails to load, **When** the page renders, **Then** it shows a retryable error message instead of the empty, cold-start "create your first dashboard" prompt.
15. `AC-063-15` **Given** a widget delete fails, **When** the failure is reported, **Then** the user sees an error message and the widget remains on the dashboard.
