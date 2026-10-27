/**
 * 桥协议常量：与 web 端 use-director-agent-bridge.tsx 的同名常量对齐（双份实现，
 * 刻意不共享代码以保证项目独立；格式变更时两边同步递增版本号）。
 */

/** hello.protocolVersion，web 端不一致时主动断开。 */
export const DIRECTOR_PROTOCOL_VERSION = 7;

/** MCP server 名，harness 据此区分 infinite-canvas / director-desk。 */
export const SERVER_NAME = "director-desk";

export const SERVER_VERSION = "0.1.0";
