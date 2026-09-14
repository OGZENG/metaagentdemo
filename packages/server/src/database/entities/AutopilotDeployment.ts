/* eslint-disable */
import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryGeneratedColumn, Index } from 'typeorm'
import { IAutopilotDeployment } from '../../Interface'

/**
 * A Workflow Autopilot crew promoted out of the experiment and into use.
 *
 * The compiled AgentFlow lives in `chat_flow` like any other flow; this row
 * keeps what the flow alone cannot say — the contract, the simulated world, the
 * acceptance suite, every published crew version with the metrics it was
 * measured at, and the cases collected while people used it. `data` is one JSON
 * document validated by `DeploymentDataType`, so the thesis model can evolve
 * without a migration per field.
 */
@Entity()
export class AutopilotDeployment implements IAutopilotDeployment {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column()
    name: string

    @Index()
    @Column({ type: 'uuid' })
    flowId: string

    @Column({ type: 'text' })
    data: string

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date

    @Column({ nullable: false, type: 'text' })
    workspaceId: string
}
