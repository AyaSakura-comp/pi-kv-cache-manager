declare module "@earendil-works/pi-coding-agent" {
  export interface ContextUsage {
    tokens: number;
    [key: string]: unknown;
  }

  export interface ReadonlySessionManager {
    getSessionId(): string;
    getSessionName(): string | undefined;
    getCwd(): string;
    getSessionDir(): string;
    getSessionFile(): string;
    [key: string]: unknown;
  }

  export interface ExtensionUIContext {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    [key: string]: unknown;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    sessionManager: ReadonlySessionManager;
    cwd: string;
    getContextUsage(): ContextUsage | undefined;
    getSystemPrompt(): string;
    [key: string]: unknown;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
    [key: string]: unknown;
  }

  export interface RegisteredCommand {
    description: string;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown): void;
    registerCommand(name: string, options: RegisteredCommand): void;
    registerTool(tool: unknown): void;
    getSessionName(): string | undefined;
    setSessionName(name: string): void;
    [key: string]: unknown;
  }
}
