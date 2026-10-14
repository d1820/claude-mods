export type Turn = { seconds: number; tools: number; tokens: number }
export type ToolStat = { count: number; ms: number }
export type ToolCall = { id: string; tool: string; isDone: boolean; agentId?: string }
export type AgentUsage = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

declare module 'claude-code' {
  interface PluginState {
    activity: {
      turnStats: Turn | null
      perTool: Record<string, ToolStat>
      recent: ToolCall[]
      isHidden: boolean
      sessionTok2: number
      planName: string | null
      wi: string | null
      artifactDir: string | null
      agentStart: Record<string, number>
      agentUsage: Record<string, AgentUsage>
      sessTurns: number
      sessAborts: number
      sessCuss: number
    }
  }
}
