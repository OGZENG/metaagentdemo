import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAutopilotDeployment1790000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "autopilot_deployment" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "flowId" varchar NOT NULL, "data" text NOT NULL, "createdDate" datetime NOT NULL DEFAULT (datetime('now')), "updatedDate" datetime NOT NULL DEFAULT (datetime('now')), "workspaceId" text NOT NULL);`
        )
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_autopilot_deployment_flowId" ON "autopilot_deployment" ("flowId");`)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_autopilot_deployment_workspace_updated" ON "autopilot_deployment" ("workspaceId", "updatedDate");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_autopilot_deployment_workspace_updated"`)
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_autopilot_deployment_flowId"`)
        await queryRunner.query(`DROP TABLE IF EXISTS "autopilot_deployment"`)
    }
}
