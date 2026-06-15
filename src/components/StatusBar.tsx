import { Box, Text } from "ink";

const VERSION = "0.1.2";

export interface AgentStats {
  total: number;
  active: number;
  idle: number;
}

export type NodeStatus = "loading" | "online" | "offline";

interface StatusBarProps {
  stats: AgentStats;
  nodeStatus: NodeStatus;
  nodeUrl: string;
  nodeRoomCount: number;
}

function formatHost(url: string): string {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

function StatusDot({ status }: { status: NodeStatus }) {
  if (status === "online") return <Text color="green">●</Text>;
  if (status === "offline") return <Text color="red">●</Text>;
  return <Text color="yellow">●</Text>;
}

export function StatusBar({ stats, nodeStatus, nodeUrl, nodeRoomCount }: StatusBarProps) {
  const host = formatHost(nodeUrl);
  const nodeLabel =
    nodeStatus === "loading"
      ? "connecting…"
      : nodeStatus === "online"
        ? `${host} (${nodeRoomCount} room${nodeRoomCount === 1 ? "" : "s"})`
        : `${host} offline`;

  const agentsTextLength = `Agents: ${stats.total}  | Active: ${stats.active}  | Idle: ${stats.idle}`.length;
  const nodeTextLength = `Node: \u25CF ${nodeLabel}`.length;
  const rightColWidth = Math.max(agentsTextLength, nodeTextLength);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width="100%"
    >
      <Box width="100%">
        <Box width={8}>
          <Text color="cyan" bold>
            {"[o_o]"}
          </Text>
        </Box>
        <Text color="cyanBright" bold>
          hspace
        </Text>
        <Text dimColor>{" "}v{VERSION}{"   "}</Text>
        <Box flexGrow={1} />
        <Box width={rightColWidth}>
          <Text>
            <Text color="cyan" bold>Agents:</Text>
            <Text> {stats.total}  </Text>
            <Text dimColor>|</Text>
            <Text color="green"> Active:</Text>
            <Text> {stats.active}  </Text>
            <Text dimColor>|</Text>
            <Text color="yellow"> Idle:</Text>
            <Text> {stats.idle}</Text>
          </Text>
        </Box>
      </Box>
      <Box width="100%">
        <Box width={8}>
          <Text color="cyan">{"/|#|\\"}</Text>
        </Box>
        <Text color="yellow">Next Gen Agentic Trading</Text>
        <Box flexGrow={1} minWidth={2} />
        <Box width={rightColWidth}>
          <Text>
            <Text color="cyan" bold>Node:</Text>
            <Text> </Text>
            <StatusDot status={nodeStatus} />
            <Text> </Text>
            <Text dimColor>{nodeLabel}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
