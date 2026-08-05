# Skill: deploy-review

Use this skill when reviewing a deployment before it goes to production.

## Checklist

* [x] Migrations reviewed

* [x] Feature flags configured

* [ ] Rollback plan documented

* [ ] On-call notified

## Steps

1. Check the diff against `main`.

   * Look for schema changes.

     * If present, confirm a matching migration exists.

     * Confirm the migration has been tested locally.

   * Look for new environment variables.

     * Confirm they are set in the target environment.
2. Check CI status.

   * All required checks green.

   * No flaky retries hiding a real failure.
3. Check the changelog entry.

   * Present, accurate, and written for the intended audience.
4. Notify stakeholders.

   * Post in the deploy channel.

   * Tag the on-call engineer.

## Nested example

* Top level item

  * Second level item

    * Third level item with `inline code` and a [link](https://example.com)

  * Back to second level

* Another top level item

## Notes

Keep this skill in sync with the actual deploy pipeline. If the pipeline changes, update this file in the same PR.
