// 新的 Webview 端消息总线
// 基于 Extension 端的 ClaudeClient 消息协议

import { reactive, ref } from 'vue';
import type {
  VSCodeAPI,
  ExtensionMessage,
  WebviewMessage,
  ClaudeEventMessage,
  ChatMessage,
  ChatState,
  SessionState,
  PermissionState,
  StreamingMessageEntry
} from '../../types/messages';
import type { QueuedMessage, MessageQueueState } from '../../types/queue';
import type { SDKMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { extractTextContent, extractContentBlocks } from '../utils/messageUtils';
import { isSDKUserMessage, isSDKAssistantMessage, isSDKStreamEvent } from '../../types/messages';
import { setToolResult, setToolUse, setPermissionRequest, setPermissionResponse, getToolMessage, upsertToolMessage } from '../stores/toolMessageStore';

// ========== 全局状态 ==========

export const chatState = reactive<ChatState>({
  messages: [],
  currentRequest: null,
  streamingMessages: new Map<string, StreamingMessageEntry>()
});

export const sessionState = reactive<SessionState>({
  currentSessionId: '',
  sessions: [],
  capabilities: []
});

export const permissionState = reactive<PermissionState>({
  pendingRequests: []
});

export const messageQueueState = reactive<MessageQueueState>({
  queuedMessages: []
});

// ========== 消息总线 ==========

class WebviewMessageBus {
  private vscode?: VSCodeAPI;
  private handlers: Map<string, Function[]> = new Map();
  private messageSequence = 0;
  private connected = ref(false);
  private toolInputBuffers = new Map<string, string>();

  constructor() {
    this.initVSCodeAPI();
    this.setupMessageListener();
    this.registerEventHandlers();
  }

  private initVSCodeAPI() {
    if (typeof window !== 'undefined') {
      if ((window as any).vscode) {
        this.vscode = (window as any).vscode;
        this.connected.value = true;
        console.log('[MessageBus] VSCode API 已连接');
      } else if ((window as any).acquireVsCodeApi) {
        try {
          this.vscode = (window as any).acquireVsCodeApi();
          (window as any).vscode = this.vscode;
          this.connected.value = true;
          console.log('[MessageBus] VSCode API 已获取');
        } catch (error) {
          console.error('[MessageBus] 获取 VSCode API 失败:', error);
        }
      } else {
        console.warn('[MessageBus] VSCode API 不可用');
      }
    }
  }

  private setupMessageListener() {
    window.addEventListener('message', (event) => {
      try {
        const message = event.data as ExtensionMessage;
        this.handleIncomingMessage(message);
      } catch (error) {
        console.error('[MessageBus] 处理接收消息失败:', error);
      }
    });
  }

  private handleIncomingMessage(message: ExtensionMessage) {
    console.log('[MessageBus] 接收消息:', message.type, message.payload);

    // 调用注册的处理器
    const handlers = this.handlers.get(message.type) || [];
    handlers.forEach(handler => {
      try {
        handler(message);
      } catch (error) {
        console.error(`[MessageBus] 处理器错误 ${message.type}:`, error);
      }
    });
  }

  /**
   * 发送消息到 Extension
   */
  send<T extends WebviewMessage>(message: T) {
    if (!this.vscode) {
      console.warn('[MessageBus] VSCode API 不可用，消息被丢弃:', message.type);
      return;
    }

    const enrichedMessage = {
      ...message,
      timestamp: Date.now(),
      uuid: this.generateUuid(),
      metadata: {
        version: '1.0.0',
        source: 'webview' as const,
        timestamp: Date.now(),
        sequence: ++this.messageSequence
      }
    };

    this.vscode.postMessage(enrichedMessage);
    console.log('[MessageBus] 发送消息:', message.type, message.payload);
  }

  /**
   * 注册消息处理器
   */
  on<T extends ExtensionMessage['type']>(
    type: T,
    handler: (message: Extract<ExtensionMessage, { type: T }>) => void
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }

    this.handlers.get(type)!.push(handler);

    // 返回取消注册函数
    return () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
        if (handlers.length === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  /**
   * 检查连接状态
   */
  isConnected(): boolean {
    return this.connected.value;
  }

  private generateUuid(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private getStreamKey(sessionId: string, blockIndex: number): string {
    return `${sessionId}:${blockIndex}`;
  }

  private getStreamEntry(sessionId: string, blockIndex: number): StreamingMessageEntry | undefined {
    return chatState.streamingMessages.get(this.getStreamKey(sessionId, blockIndex));
  }

  private setStreamEntry(entry: StreamingMessageEntry): void {
    chatState.streamingMessages.set(this.getStreamKey(entry.sessionId, entry.blockIndex), entry);
  }

  private clearStreamEntry(sessionId: string, blockIndex: number): void {
    chatState.streamingMessages.delete(this.getStreamKey(sessionId, blockIndex));
  }

  private tryParseJson(value: string): any | undefined {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  /**
   * 注册所有事件处理器
   */
  private registerEventHandlers() {
    // 处理 Claude 事件
    this.on('claude/event', (message) => {
      this.handleClaudeEvent(message as ClaudeEventMessage);
    });

    // 处理会话列表
    this.on('session/list', (message) => {
      sessionState.sessions = message.payload.sessions;
      console.log('[MessageBus] 会话列表已更新:', sessionState.sessions.length);
    });

    // 处理当前会话
    this.on('session/current', (message) => {
      sessionState.currentSessionId = message.payload.sessionId;

      // 重放历史消息
      chatState.messages = [];
      for (const msg of message.payload.messages) {
        const result = this.convertToUIMessage(msg);
        if (result) {
          if (Array.isArray(result)) {
            // 助手消息可能返回多个消息（文本+工具）
            chatState.messages.push(...result);
          } else {
            chatState.messages.push(result);
          }
        }
      }

      console.log('[MessageBus] 当前会话已加载:', message.payload.sessionId);
    });

    // 处理会话创建
    this.on('session/created', (message) => {
      sessionState.currentSessionId = message.payload.sessionId || '';
      chatState.messages = [];
      console.log('[MessageBus] 新会话已创建:', message.payload.sessionId);
    });

    // 处理系统就绪
    this.on('system/ready', (message) => {
      sessionState.capabilities = message.payload.capabilities;
      console.log('[MessageBus] 系统就绪:', message.payload.capabilities);
    });

    // 处理系统错误
    this.on('system/error', (message) => {
      console.error('[MessageBus] 系统错误:', message.payload.message);
      // 可以在这里显示错误提示给用户
    });
  }

  /**
   * 处理 Claude 事件
   */
  private handleClaudeEvent(message: ClaudeEventMessage) {
    const event = message.payload;
    console.log('[MessageBus] Claude 事件:', event.kind, event);
    console.log(event.message);

    switch (event.kind) {
      case 'user':
        this.handleUserMessage(event);
        break;
      case 'assistant':
        this.handleAssistantMessage(event);
        break;
      case 'stream_event':
        this.handleStreamEvent(event);
        break;
      case 'permission_request':
        this.handlePermissionRequest(event);
        break;
      case 'permission_decision':
        this.handlePermissionDecision(event);
        break;
      case 'result':
        this.handleResult(event);
        break;
      case 'system':
        this.handleSystemMessage(event);
        break;
      case 'error':
        this.handleError(event);
        break;
      default:
        console.warn('[MessageBus] 未知 Claude 事件:', (event as ClaudeEventMessage['payload']).kind);
    }
  }

  private handleUserMessage(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'user' || !event.message) {
      return;
    }

    const sdkMessage = event.message;

    // 检查是否是 SDK 用户消息类型
    if (!isSDKUserMessage(sdkMessage)) {
      return;
    }

    // 检查是否是元数据消息，如果是则跳过渲染
    if ((sdkMessage as any).isMeta) {
      console.log('[MessageBus] 跳过元数据消息');
      return;
    }

    // 访问实际的消息内容，这里我们知道结构但需要安全访问
    const messageObj = (sdkMessage as Record<string, any>).message;
    if (!messageObj || !messageObj.content) {
      return;
    }

    const messageContent = messageObj.content;

    // 处理不同的content格式
    if (typeof messageContent === 'string') {
      // 检查是否为系统中断消息
      if (messageContent.includes('[Request interrupted by')) {
        const message: ChatMessage = {
          id: `system_${Date.now()}`,
          sdkMessage,
          role: 'system',
          content: messageContent,
          contentBlocks: [{ type: 'text', text: messageContent }],
          timestamp: Date.now(),
          status: 'sent',
          sessionId: sdkMessage.session_id || ''
        };
        chatState.messages.push(message);
        console.log('[MessageBus] 创建系统中断消息');
      } else {
        // 纯文本消息 - 创建用户消息
        const message: ChatMessage = {
          id: `user_${Date.now()}`,
          sdkMessage,
          role: 'user',
          content: messageContent,
          contentBlocks: [{ type: 'text', text: messageContent }],
          timestamp: Date.now(),
          status: 'sent',
          sessionId: sdkMessage.session_id || ''
        };
        chatState.messages.push(message);
        console.log('[MessageBus] 创建用户文本消息');
      }
    } else if (Array.isArray(messageContent)) {
      // 检查第一个内容块的类型来决定处理方式
      const firstBlock = messageContent[0];

      if (firstBlock && firstBlock.type === 'tool_result') {
        // 这是 tool_result 消息 - 只更新 ToolMessage，不创建用户消息
        messageContent.forEach((block: Record<string, any>) => {
          if (block.type === 'tool_result' && block.tool_use_id) {
            console.log('[MessageBus] 处理 tool_result:', block.tool_use_id);

            // 获取 toolUseResult（在 sdkMessage 顶层）
            const toolUseResult = (sdkMessage as Record<string, any>).toolUseResult;

            setToolResult({
              content: block.content,
              is_error: Boolean(block.is_error),
              tool_use_id: block.tool_use_id
            });

            // 保存 toolUseResult 到 store
            if (toolUseResult) {
              const toolMessage = getToolMessage(block.tool_use_id);
              if (toolMessage) {
                upsertToolMessage(block.tool_use_id, {
                  toolUseResult
                });
              }
            }
          }
        });
        console.log('[MessageBus] tool_result 消息处理完成，不创建用户消息');
      } else {
        // 包含文本或其他类型 - 创建用户消息
        let textContent = '';
        messageContent.forEach((block: Record<string, any>) => {
          if (block.type === 'text' && typeof block.text === 'string') {
            textContent += block.text;
          }
        });

        if (textContent.trim()) {
          // 检查是否为系统中断消息
          if (textContent.includes('[Request interrupted by')) {
            const message: ChatMessage = {
              id: `system_${Date.now()}`,
              sdkMessage,
              role: 'system',
              content: textContent,
              contentBlocks: [{ type: 'text', text: textContent }],
              timestamp: Date.now(),
              status: 'sent',
              sessionId: sdkMessage.session_id || ''
            };
            chatState.messages.push(message);
            console.log('[MessageBus] 创建系统中断消息');
          } else {
            const message: ChatMessage = {
              id: `user_${Date.now()}`,
              sdkMessage,
              role: 'user',
              content: textContent,
              contentBlocks: [{ type: 'text', text: textContent }],
              timestamp: Date.now(),
              status: 'sent',
              sessionId: sdkMessage.session_id || ''
            };
            chatState.messages.push(message);
            console.log('[MessageBus] 创建用户文本消息');
          }
        }
      }
    }
  }

  private handleAssistantMessage(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'assistant' || !event.message || event.message.type !== 'assistant') {
      return;
    }

    const sdkMessage = event.message;

    // 检查是否是 SDK 助手消息类型
    if (!isSDKAssistantMessage(sdkMessage)) {
      return;
    }

    // 访问实际的消息内容
    const messageObj = (sdkMessage as Record<string, any>).message;
    if (!messageObj || !messageObj.content) {
      return;
    }

    const messageContent = messageObj.content;
    let textContent = '';
    let hasTextContent = false;

    // 处理内容块数组
    if (Array.isArray(messageContent)) {
      messageContent.forEach((block: Record<string, any>) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          textContent += block.text;
          hasTextContent = true;
        } else if (block.type === 'tool_use' && block.id && block.name) {
          // 创建独立的 ToolMessage
          this.createToolMessage(block, sdkMessage);
        }
      });
    }

    // 只有当助手消息包含文本内容时才创建助手文本消息
    if (hasTextContent && textContent.trim()) {
      const sessionId = sdkMessage.session_id || '';
      let existingIndex = -1;
      for (let i = chatState.messages.length - 1; i >= 0; i--) {
        const candidate = chatState.messages[i];
        if (candidate.sessionId === sessionId && candidate.role === 'assistant' && candidate.type !== 'tool_use') {
          existingIndex = i;
          break;
        }
      }

      if (existingIndex !== -1) {
        const existingMessage = chatState.messages[existingIndex];
        existingMessage.content = textContent;
        existingMessage.contentBlocks = [{ type: 'text', text: textContent }];
        existingMessage.streaming = false;
        existingMessage.status = 'completed';
        existingMessage.sdkMessage = sdkMessage;
      } else {
        const message: ChatMessage = {
          id: `assistant_${Date.now()}`,
          sdkMessage,
          role: 'assistant',
          content: textContent,
          contentBlocks: [{ type: 'text', text: textContent }],
          timestamp: Date.now(),
          status: 'completed',
          streaming: false,
          sessionId
        };
        chatState.messages.push(message);
      }
    }
  }

  private createToolMessage(toolUseBlock: Record<string, any>, sdkMessage: SDKMessage): number {
    console.log('[MessageBus] 创建工具消息:', toolUseBlock.name, toolUseBlock.id);

    const messageId = `tool_${toolUseBlock.id}`;
    const sessionId = (sdkMessage as Record<string, any>).session_id || '';
    const existingIndex = chatState.messages.findIndex(msg => msg.id === messageId);
    const contentBlock = {
      type: 'tool_use' as const,
      id: toolUseBlock.id,
      name: toolUseBlock.name,
      input: toolUseBlock.input
    };

    if (existingIndex !== -1) {
      const existingMessage = chatState.messages[existingIndex];
      existingMessage.sdkMessage = sdkMessage;
      existingMessage.content = `使用工具: ${toolUseBlock.name}`;
      existingMessage.contentBlocks = [contentBlock];
      existingMessage.timestamp = Date.now();
      existingMessage.sessionId = sessionId;

      setToolUse({
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        input: toolUseBlock.input
      });

      return existingIndex;
    }

    const toolMessage: ChatMessage = {
      id: messageId,
      sdkMessage,
      role: 'assistant',
      content: `使用工具: ${toolUseBlock.name}`,
      contentBlocks: [contentBlock],
      timestamp: Date.now(),
      status: 'sent',
      sessionId,
      type: 'tool_use'
    };

    const index = chatState.messages.push(toolMessage) - 1;
    console.log('[MessageBus] 工具消息已添加到 chatState，当前消息数量:', chatState.messages.length);

    setToolUse({
      id: toolUseBlock.id,
      name: toolUseBlock.name,
      input: toolUseBlock.input
    });

    return index;
  }

  private handleStreamEvent(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'stream_event' || !event.message || !isSDKStreamEvent(event.message)) {
      return;
    }

    const sdkMessage = event.message as SDKPartialAssistantMessage;
    const streamEvent = sdkMessage.event;
    if (!streamEvent) {
      return;
    }

    const sessionId = sdkMessage.session_id || '';

    switch (streamEvent.type) {
      case 'content_block_start': {
        const blockIndex = streamEvent.index;
        const block = streamEvent.content_block;

        if (block.type === 'text') {
          const message: ChatMessage = {
            id: `stream_${sessionId}_${blockIndex}_${Date.now()}`,
            sdkMessage,
            role: 'assistant',
            content: '',
            contentBlocks: [{ type: 'text', text: '' }],
            timestamp: Date.now(),
            status: 'streaming',
            streaming: true,
            sessionId,
            metadata: {
              parentToolUseId: sdkMessage.parent_tool_use_id || undefined
            }
          };

          const messageIndex = chatState.messages.push(message) - 1;
          this.setStreamEntry({
            sessionId,
            blockIndex,
            messageIndex,
            contentType: 'text'
          });
        } else if (block.type === 'tool_use') {
          const messageIndex = this.createToolMessage(block as Record<string, any>, sdkMessage);
          this.setStreamEntry({
            sessionId,
            blockIndex,
            messageIndex,
            contentType: 'tool_use',
            toolUseId: block.id
          });

          if (typeof block.input === 'string') {
            this.toolInputBuffers.set(block.id, block.input);
          } else if (block.input !== undefined) {
            try {
              this.toolInputBuffers.set(block.id, JSON.stringify(block.input));
            } catch {
              this.toolInputBuffers.set(block.id, String(block.input));
            }
          } else {
            this.toolInputBuffers.set(block.id, '');
          }
        }
        break;
      }
      case 'content_block_delta': {
        const entry = this.getStreamEntry(sessionId, streamEvent.index);
        if (!entry) {
          return;
        }

        if (entry.contentType === 'text' && streamEvent.delta.type === 'text_delta') {
          const deltaText = streamEvent.delta.text || '';
          if (!deltaText) {
            return;
          }
          const message = chatState.messages[entry.messageIndex];
          if (message) {
            message.content += deltaText;
            message.streaming = true;
            message.status = 'streaming';
            if (!message.contentBlocks || message.contentBlocks.length === 0) {
              message.contentBlocks = [{ type: 'text', text: deltaText }];
            } else {
              const block = message.contentBlocks[0];
              if (block.type === 'text') {
                block.text = (block.text || '') + deltaText;
              }
            }
            message.sdkMessage = sdkMessage;
          }
        } else if (entry.contentType === 'tool_use' && entry.toolUseId && streamEvent.delta.type === 'input_json_delta') {
          const accumulated = (this.toolInputBuffers.get(entry.toolUseId) || '') + streamEvent.delta.partial_json;
          this.toolInputBuffers.set(entry.toolUseId, accumulated);
          const parsed = this.tryParseJson(accumulated);

          const toolMessage = chatState.messages[entry.messageIndex];
          if (toolMessage?.contentBlocks?.[0]) {
            toolMessage.contentBlocks[0].input = parsed ?? accumulated;
          }

          const toolName = toolMessage?.contentBlocks?.[0]?.name || getToolMessage(entry.toolUseId)?.toolUse?.name || '';
          upsertToolMessage(entry.toolUseId, {
            toolUse: {
              id: entry.toolUseId,
              name: toolName,
              input: parsed ?? accumulated
            }
          });
        }
        break;
      }
      case 'content_block_stop': {
        const entry = this.getStreamEntry(sessionId, streamEvent.index);
        if (!entry) {
          return;
        }

        const message = chatState.messages[entry.messageIndex];
        if (message && entry.contentType === 'text') {
          message.streaming = false;
          message.status = 'completed';
        }

        if (entry.contentType === 'tool_use' && entry.toolUseId) {
          const buffer = this.toolInputBuffers.get(entry.toolUseId);
          if (buffer !== undefined) {
            const parsed = this.tryParseJson(buffer);
            const toolMessage = chatState.messages[entry.messageIndex];
            const toolName = toolMessage?.contentBlocks?.[0]?.name || getToolMessage(entry.toolUseId)?.toolUse?.name || '';
            if (toolMessage?.contentBlocks?.[0]) {
              toolMessage.contentBlocks[0].input = parsed ?? buffer;
            }

            upsertToolMessage(entry.toolUseId, {
              toolUse: {
                id: entry.toolUseId,
                name: toolName,
                input: parsed ?? buffer
              }
            });
          }

          this.toolInputBuffers.delete(entry.toolUseId);
        }

        this.clearStreamEntry(sessionId, entry.blockIndex);
        break;
      }
      case 'message_stop': {
        for (const [key, entry] of Array.from(chatState.streamingMessages.entries())) {
          if (entry.sessionId === sessionId && entry.contentType === 'text') {
            const message = chatState.messages[entry.messageIndex];
            if (message) {
              message.streaming = false;
              message.status = 'completed';
            }
            chatState.streamingMessages.delete(key);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private handlePermissionRequest(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'permission_request') {
      return;
    }

    const request = {
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      input: event.input,
      timestamp: Date.now()
    };

    permissionState.pendingRequests.push(request);
    console.log('[MessageBus] 权限请求:', request);

    // 更新对应工具消息的权限状态
    setPermissionRequest(event.toolUseId, event.toolUseId);
    console.log('[MessageBus] 已关联权限请求到工具消息:', { toolUseId: event.toolUseId });
  }

  private handlePermissionDecision(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'permission_decision') {
      return;
    }

    console.log('[MessageBus] 权限决策:', event);

    // 更新工具消息的权限状态
    const allowed = event.result?.behavior === 'allow';
    setPermissionResponse(event.toolUseId, allowed);

    // 从待处理列表中移除
    const index = permissionState.pendingRequests.findIndex(r => r.toolUseId === event.toolUseId);
    if (index !== -1) {
      permissionState.pendingRequests.splice(index, 1);
    }

    console.log('[MessageBus] 权限决策已处理:', { toolUseId: event.toolUseId, allowed });
  }

  private handleError(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'error') {
      return;
    }

    const content = `错误: ${event.message}`;
    const message: ChatMessage = {
      id: `error_${Date.now()}`,
      role: 'error',
      content,
      contentBlocks: [{ type: 'text', text: content }],
      timestamp: Date.now(),
      status: 'error',
      metadata: {
        error: event.message
      }
    };
    chatState.messages.push(message);
  }

  private handleResult(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'result') {
      return;
    }

    if (chatState.currentRequest) {
      chatState.currentRequest = null;
    }

    chatState.streamingMessages.clear();

    // 对话结束，处理下一个队列消息
    processNextQueuedMessage();
  }

  private handleSystemMessage(event: ClaudeEventMessage['payload']) {
    if (event.kind !== 'system') {
      return;
    }

    console.log('[MessageBus] 系统消息:', event);
  }

  private convertToUIMessage(sdkMessage: SDKMessage): ChatMessage | ChatMessage[] | null {
    if (!sdkMessage) {
      return null;
    }

    if ((sdkMessage as any).isMeta) {
      console.log('[MessageBus] 跳过元数据消息（历史加载）');
      return null;
    }

    const content = extractTextContent(sdkMessage);
    const contentBlocks = extractContentBlocks(sdkMessage);

    switch (sdkMessage.type) {
      case 'user': {
        // 检查是否是纯 tool_result 消息
        const messageObj = (sdkMessage as Record<string, any>).message;
        if (messageObj && Array.isArray(messageObj.content)) {
          const firstBlock = messageObj.content[0];
          if (firstBlock && firstBlock.type === 'tool_result') {
            // 纯 tool_result 消息不创建 UserMessage，只更新 ToolMessage
            messageObj.content.forEach((block: Record<string, any>) => {
              if (block.type === 'tool_result' && block.tool_use_id) {
                setToolResult({
                  content: block.content,
                  is_error: Boolean(block.is_error),
                  tool_use_id: block.tool_use_id
                });

                // 保存 toolUseResult
                const toolUseResult = (sdkMessage as Record<string, any>).toolUseResult;
                if (toolUseResult) {
                  upsertToolMessage(block.tool_use_id, {
                    toolUseResult
                  });
                }
              }
            });
            return null; // 不创建消息
          }
        }

        // 只有包含实际文本内容的用户消息才创建
        if (content && content.trim()) {
          // 检查是否为系统中断消息
          if (content.includes('[Request interrupted by')) {
            return {
              id: `system_${Date.now()}_${Math.random()}`,
              sdkMessage,
              role: 'system',
              content,
              contentBlocks,
              timestamp: Date.now(),
              status: 'sent',
              sessionId: sdkMessage.session_id
            };
          }

          return {
            id: `user_${Date.now()}_${Math.random()}`,
            sdkMessage,
            role: 'user',
            content,
            contentBlocks,
            timestamp: Date.now(),
            status: 'sent',
            sessionId: sdkMessage.session_id
          };
        }
        return null; // 空内容不创建消息
      }
      case 'assistant': {
        // 检查是否包含 tool_use
        const messageObj = (sdkMessage as Record<string, any>).message;
        const messages: ChatMessage[] = [];

        if (messageObj && Array.isArray(messageObj.content)) {
          // 分离文本和工具调用
          let textContent = '';
          let hasText = false;

          messageObj.content.forEach((block: Record<string, any>) => {
            if (block.type === 'text' && typeof block.text === 'string') {
              textContent += block.text;
              hasText = true;
            } else if (block.type === 'tool_use' && block.id && block.name) {
              // 创建独立的工具消息
              const toolMessage: ChatMessage = {
                id: `tool_${block.id}`,
                sdkMessage,
                role: 'assistant',
                content: `使用工具: ${block.name}`,
                contentBlocks: [{
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input
                }],
                timestamp: Date.now(),
                status: 'sent',
                sessionId: sdkMessage.session_id || '',
                type: 'tool_use' // 标记为工具消息
              };
              messages.push(toolMessage);

              // 更新 toolMessageStore
              setToolUse({
                id: block.id,
                name: block.name,
                input: block.input
              });
            }
          });

          // 如果有文本内容，创建文本消息
          if (hasText && textContent.trim()) {
            messages.push({
              id: `assistant_${Date.now()}_${Math.random()}`,
              sdkMessage,
              role: 'assistant',
              content: textContent,
              contentBlocks: [{ type: 'text', text: textContent }],
              timestamp: Date.now(),
              status: 'completed',
              sessionId: sdkMessage.session_id || ''
            });
          }
        }

        // 返回所有消息
        return messages.length > 0 ? (messages.length === 1 ? messages[0] : messages) : null;
      }
      case 'result':
      case 'system':
        return {
          id: `${sdkMessage.type}_${Date.now()}_${Math.random()}`,
          sdkMessage,
          role: 'system',
          content,
          contentBlocks,
          timestamp: Date.now(),
          status: 'completed',
          sessionId: sdkMessage.session_id
        };
      default:
        return null;
    }
  }
}

// 创建全局消息总线实例
export const messageBus = new WebviewMessageBus();

// ========== 便捷 API ==========

/**
 * 发送权限响应
 */
export function sendPermissionResponse(toolUseId: string, result: any): void {
  messageBus.send({
    type: 'permission/response',
    payload: {
      toolUseId,
      result
    }
  });
}

/**
 * 发送聊天消息
 */
export function sendChatMessage(text: string, sessionId?: string): string {
  const requestId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // 添加用户消息到状态
  // const userMessage: ChatMessage = {
  //   id: `user_${Date.now()}`,
  //   role: 'user',
  //   content: text,
  //   contentBlocks: [{ type: 'text', text }],
  //   timestamp: Date.now(),
  //   status: 'sending'
  // };
  // chatState.messages.push(userMessage);

  // 设置当前请求状态
  chatState.currentRequest = {
    id: requestId,
    status: 'sending',
    startTime: Date.now()
  };

  // 发送到 Extension
  messageBus.send({
    type: 'chat/send',
    payload: { text, sessionId }
  });

  return requestId;
}

/**
 * 中断聊天请求
 */
export function interruptChat() {
  messageBus.send({
    type: 'chat/interrupt',
    payload: {}
  });

  // 清除请求状态
  chatState.currentRequest = null;
  chatState.streamingMessages.clear();
}

/**
 * 加载会话
 */
export function loadSession(sessionId: string) {
  messageBus.send({
    type: 'session/load',
    payload: { sessionId }
  });
}

/**
 * 创建新会话
 */
export function createNewSession() {
  messageBus.send({
    type: 'session/create',
    payload: {}
  });
}

/**
 * 请求会话列表
 */
export function requestSessionList() {
  messageBus.send({
    type: 'session/list',
    payload: {}
  });
}

/**
 * 响应权限请求
 */
export function respondToPermission(
  toolUseId: string,
  behavior: 'allow' | 'deny',
  options?: {
    updatedInput?: any;
    message?: string;
    interrupt?: boolean;
  }
) {
  messageBus.send({
    type: 'permission/response',
    payload: {
      toolUseId,
      result: {
        behavior,
        ...options
      }
    }
  });

  // 从待处理列表中移除
  const index = permissionState.pendingRequests.findIndex(
    req => req.toolUseId === toolUseId
  );
  if (index !== -1) {
    permissionState.pendingRequests.splice(index, 1);
  }
}

/**
 * 通知 UI 就绪
 */
export function notifyUIReady() {
  messageBus.send({
    type: 'ui/ready',
    payload: {}
  });
}

// ========== 消息队列管理 ==========

/**
 * 添加消息到队列
 */
export function addMessageToQueue(content: string): void {
  const queuedMessage: QueuedMessage = {
    id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    content,
    timestamp: Date.now()
  };
  messageQueueState.queuedMessages.push(queuedMessage);
}

/**
 * 从队列中移除消息
 */
export function removeMessageFromQueue(messageId: string): void {
  const index = messageQueueState.queuedMessages.findIndex(msg => msg.id === messageId);
  if (index !== -1) {
    messageQueueState.queuedMessages.splice(index, 1);
  }
}


/**
 * 清空消息队列
 */
export function clearMessageQueue(): void {
  messageQueueState.queuedMessages = [];
}

/**
 * 获取下一个队列消息并发送
 */
export function processNextQueuedMessage(): void {
  if (messageQueueState.queuedMessages.length > 0) {
    const nextMessage = messageQueueState.queuedMessages.shift();
    if (nextMessage) {
      sendChatMessage(nextMessage.content);
    }
  }
}

// 初始化时通知 UI 就绪
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    setTimeout(() => {
      notifyUIReady();
      requestSessionList();
    }, 100);
  });
}