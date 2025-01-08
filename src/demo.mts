import 'dotenv/config'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { Anthropic } from '@anthropic-ai/sdk'
import axios from 'axios'

// AI Provider 接口
interface AIProvider {
    generateResponse(messages: Message[]): Promise<string>
}

// Message 接口
interface Message {
    role: 'user' | 'assistant' | 'system'
    content: string
}

interface ToolCall {
    tool: string
    params: Record<string, string>
}

// Claude Provider 实现
class ClaudeProvider implements AIProvider {
    private client: Anthropic

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey })
    }

    async generateResponse(messages: Message[]): Promise<string> {
        const response = await this.client.messages.create({
            model: 'claude-3-sonnet-20240229',
            max_tokens: 4096,
            messages: messages.map(msg => ({
                role: msg.role === 'system' ? 'user' : msg.role,
                content: msg.content
            }))
        })
        
        if (!response.content[0] || !('text' in response.content[0])) {
            throw new Error('Unexpected response format from Claude API')
        }
        return response.content[0].text
    }
}

// DeepSeek Provider 实现
class DeepSeekProvider implements AIProvider {
    private apiKey: string
    private apiUrl: string

    constructor(apiKey: string) {
        this.apiKey = apiKey
        this.apiUrl = 'https://api.deepseek.com/v1/chat/completions'  // 替换为实际的 DeepSeek API 地址
    }

    async generateResponse(messages: Message[]): Promise<string> {
        const response = await axios.post(
            this.apiUrl,
            {
                model: 'deepseek-chat',  // 替换为实际的模型名称
                messages: messages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }))
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        )
        return response.data.choices[0].message.content
    }
}

// 修改 SimpleAIAgent 类以支持不同的 Provider
class SimpleAIAgent {
    private provider: AIProvider
    private systemPrompt: string
    private conversationHistory: Message[] = []
    private cwd: string

    constructor(provider: AIProvider, workingDirectory: string) {
        this.provider = provider
        this.cwd = workingDirectory
        this.systemPrompt = this.getSystemPrompt()
    }

    private getSystemPrompt(): string {
        return `You are a helpful AI assistant that can help users with file operations and coding tasks.

AVAILABLE TOOLS:

1. read_file: Read file contents
<read_file>
<path>file path relative to ${this.cwd}</path>
</read_file>

2. write_file: Create or modify files
<write_file>
<path>file path relative to ${this.cwd}</path>
<content>file content</content>
</write_file>

RULES:
1. You can only use the tools defined above
2. Always wait for user confirmation after each tool use
3. Be direct and efficient in responses
4. Focus on code implementation over explanations
5. Current working directory is: ${this.cwd}

WORKFLOW:
1. Analyze user request
2. Choose appropriate tool
3. Execute tool with proper parameters
4. Wait for confirmation
5. Continue or complete task`
    }

    private async executeReadFile(path: string): Promise<string> {
        const fullPath = this.resolvePath(path)
        return await fs.readFile(fullPath, 'utf-8')
    }

    private async executeWriteFile(path: string, content: string): Promise<void> {
        const fullPath = this.resolvePath(path)
        await fs.mkdir(this.getDirname(fullPath), { recursive: true })
        await fs.writeFile(fullPath, content)
    }

    private resolvePath(filePath: string): string {
        return path.resolve(this.cwd, filePath)
    }

    private getDirname(filePath: string): string {
        return path.dirname(filePath)
    }

    private async parseToolCall(message: string): Promise<ToolCall | null> {
        const toolMatch = message.match(/<(\w+)>([\s\S]*?)<\/\1>/m)
        if (!toolMatch) return null

        const tool = toolMatch[1]
        const paramsContent = toolMatch[2]
        const params: Record<string, string> = {}

        const paramMatches = paramsContent.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/gm)
        for (const match of paramMatches) {
            params[match[1]] = match[2].trim()
        }

        return { tool, params }
    }

    private async executeTool(tool: string, params: Record<string, string>): Promise<string> {
        switch (tool) {
            case 'read_file':
                return await this.executeReadFile(params.path)
            case 'write_file':
                await this.executeWriteFile(params.path, params.content)
                return `File written successfully: ${params.path}`
            default:
                throw new Error(`Unknown tool: ${tool}`)
        }
    }

    public async processUserInput(userInput: string): Promise<string> {
        try {
            // 添加用户输入到历史记录
            this.conversationHistory.push({
                role: 'user' as const,
                content: userInput
            })

            // 构建完整的消息历史
            const messages: Message[] = [
                {
                    role: 'system' as const,
                    content: this.systemPrompt
                },
                ...this.conversationHistory
            ]

            // 使用 Provider 生成响应
            const assistantMessage = await this.provider.generateResponse(messages)
            
            // 解析工具调用
            const toolCall = await this.parseToolCall(assistantMessage)
            if (toolCall) {
                // 执行工具调用
                const result = await this.executeTool(toolCall.tool, toolCall.params)
                
                // 添加工具执行结果到历史记录
                this.conversationHistory.push({
                    role: 'assistant' as const,
                    content: assistantMessage
                })
                this.conversationHistory.push({
                    role: 'user' as const,
                    content: `Tool execution result: ${result}`
                })

                return `Tool ${toolCall.tool} executed: ${result}`
            }

            // 添加 AI 响应到历史记录
            this.conversationHistory.push({
                role: 'assistant' as const,
                content: assistantMessage
            })

            return assistantMessage
        } catch (error) {
            console.error('Error processing user input:', error)
            throw error
        }
    }
}

// 修改 main 函数以支持两种运行方式
async function main() {
    const claudeApiKey = process.env.ANTHROPIC_API_KEY
    const deepseekApiKey = process.env.DEEPSEEK_API_KEY

    if (!claudeApiKey && !deepseekApiKey) {
        throw new Error('Either ANTHROPIC_API_KEY or DEEPSEEK_API_KEY is required')
    }

    // 创建 provider (使用 DeepSeek)
    const provider = new DeepSeekProvider(deepseekApiKey!)
    const agent = new SimpleAIAgent(provider, process.cwd())

    try {
        // 获取命令行参数
        const userInput = process.argv.slice(2).join(' ')
        
        // 如果没有命令行参数，进入交互模式
        if (!userInput) {
            console.log('Welcome to AI Demo! Please enter your prompt (or type "exit" to quit):')
            // 使用 Node.js 内置的 readline 模块
            const readline = await import('node:readline/promises')
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            })

            while (true) {
                const input = await rl.question('\nYour prompt > ')
                if (input.toLowerCase() === 'exit') {
                    console.log('Goodbye!')
                    break
                }
                if (input.trim()) {
                    const result = await agent.processUserInput(input)
                    console.log('\nAI Response:', result)
                }
            }

            rl.close()
            return
        }

        // 命令行模式
        const result = await agent.processUserInput(userInput)
        console.log('AI Response:', result)
    } catch (error) {
        console.error('Error:', error)
        process.exit(1)
    }
}

main() 