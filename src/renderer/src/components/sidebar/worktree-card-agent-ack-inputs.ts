import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import {
  isAgentRowUnread,
  type AgentRowUnreadState
} from '@/components/dashboard/dashboard-row-bucket'

/** Projects only the unread flags rendered by one card. */
export function selectAgentRowsUnread(
  state: AgentRowUnreadState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey'>[]
): boolean[] {
  return agents.map((agent) => isAgentRowUnread(state, agent.paneKey))
}
