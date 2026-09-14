import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAutopilotDeployment1790000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS autopilot_deployment (
                id uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" varchar NOT NULL,
                "flowId" uuid NOT NULL,
                "data" text NOT NULL,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                "workspaceId" text NOT NULL,
                CONSTRAINT "PK_autopilot_deployment_id" PRIMARY KEY (id)
            );`
        )
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_autopilot_deployment_flowId" ON autopilot_deployment ("flowId");`)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_autopilot_deployment_workspace_updated" ON autopilot_deployment ("workspaceId", "updatedDate");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_autopilot_deployment_workspace_updated"`)
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_autopilot_deployment_flowId"`)
        await queryRunner.query(`DROP TABLE IF EXISTS autopilot_deployment`)
    }
}
