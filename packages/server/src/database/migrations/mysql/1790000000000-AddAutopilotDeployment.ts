import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAutopilotDeployment1790000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // `data` holds the contract, the simulated world and every crew version,
        // which outgrows MySQL's 64 KB `text` quickly — hence longtext.
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS \`autopilot_deployment\` (
                \`id\` varchar(36) NOT NULL,
                \`name\` varchar(255) NOT NULL,
                \`flowId\` varchar(36) NOT NULL,
                \`data\` longtext NOT NULL,
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                \`workspaceId\` varchar(36) NOT NULL,
                PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`
        )
        await queryRunner.query(`CREATE INDEX \`IDX_autopilot_deployment_flowId\` ON \`autopilot_deployment\` (\`flowId\`);`)
        await queryRunner.query(
            `CREATE INDEX \`IDX_autopilot_deployment_workspace_updated\` ON \`autopilot_deployment\` (\`workspaceId\`, \`updatedDate\`);`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`IDX_autopilot_deployment_workspace_updated\` ON \`autopilot_deployment\``)
        await queryRunner.query(`DROP INDEX \`IDX_autopilot_deployment_flowId\` ON \`autopilot_deployment\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`autopilot_deployment\``)
    }
}
