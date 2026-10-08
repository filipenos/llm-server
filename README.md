# llm-server

Gateway local compatível com o subconjunto de texto da API OpenAI. Usa os logins existentes do Codex, Claude Code e Antigravity CLI, através dos SDKs oficiais de agentes e do comando `agy`.

## Executar

Requisitos: Node.js 22+, `codex`, `claude` e, para Google, `agy` instalados e autenticados. O login do aplicativo Antigravity pode não autenticar o CLI: execute `agy` interativamente para conferir.

```sh
git clone https://github.com/filipenos/llm-server.git
cd llm-server
npm ci
npm run models
npm run build
npm start
```

Endereço padrão: `http://127.0.0.1:10434/v1`. O servidor escuta em `0.0.0.0`, aceitando conexões pelas interfaces de rede da máquina. Em outro host, use `http://<IP-do-servidor>:10434/v1`. Não há banco, Docker ou serviço externo adicional. Para desenvolvimento: `npm run dev`.

O comando `npm run models` consulta os catálogos do Codex, Claude e Antigravity pelos clientes oficiais, sem gerar respostas. Atualiza `~/.llm-server/config.json` e imprime os IDs completos para usar no campo `model`, preservando IDs existentes e padrões configurados. Os modelos retornados pelo catálogo ainda dependem dos limites e permissões da sua conta. O catálogo Antigravity é obtido com `agy models`. Se o servidor estiver rodando, reinicie-o para carregar a lista atualizada.

## Chamada rápida

```sh
curl http://localhost:10434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Olá!"}]}'
```

Sem `model`, usa Gemini 3.8 Flash low pelo AGY.

Este servidor é destinado ao uso pessoal em uma rede de confiança. Não autentica requisições HTTP: `apiKey: "local"` nos exemplos é apenas o valor exigido pelo SDK cliente. A geração usa a internet e os limites das contas autenticadas nos provedores; os modelos não rodam nesta máquina.

## Escolher outra LLM

O endereço e o formato da requisição são os mesmos para todos os provedores. Troque apenas o campo `model`:

| Campo `model`                 | Login utilizado     | Modelo escolhido                               |
| ----------------------------- | ------------------- | ---------------------------------------------- |
| omitido                       | Antigravity (`agy`) | Gemini 3.8 Flash low                           |
| `"codex"`                     | Codex               | Luna por padrão                                |
| `"claude"`                    | Claude Code         | Padrão do Claude ou `defaultModel` configurado |
| `"gemini"` ou `"antigravity"` | Antigravity (`agy`) | Padrão do AGY ou `defaultModel` configurado    |
| `"codex/<ID>"`                | Codex               | ID específico do catálogo                      |
| `"claude/<ID>"`               | Claude Code         | ID específico do catálogo                      |
| `"antigravity/<ID>"`          | Antigravity (`agy`) | ID específico do catálogo                      |

Para usar Claude:

```sh
curl http://localhost:10434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude","messages":[{"role":"user","content":"Olá!"}]}'
```

Para usar o provedor do Gemini via AGY:

```sh
curl http://localhost:10434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini","messages":[{"role":"user","content":"Olá!"}]}'
```

Para escolher um modelo exato, execute `npm run models` e copie um ID completo da saída, como `codex/gpt-6-luna`, para o campo `model`. O prefixo escolhe o cliente e o login: modelos Claude oferecidos pelo AGY também usam `antigravity/<ID>`. O alias `gemini` seleciona o provedor AGY; para garantir um modelo Gemini específico, use seu ID completo ou configure `providers.antigravity.defaultModel`.

Com o servidor iniciado, consulte o catálogo carregado pela API:

```sh
curl http://localhost:10434/v1/models
```

No SDK OpenAI, use os mesmos valores: `model: "claude"`, `model: "gemini"` ou um ID completo copiado do catálogo. Para mudar de provedor ou modelo, inicie uma nova conversa sem `X-Conversation-Id`.

## Usar com o SDK OpenAI

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:10434/v1",
  apiKey: "local",
  maxRetries: 0,
});

const { data, response } = await client.chat.completions
  .create({
    model: "claude",
    messages: [{ role: "user", content: "Explique closures em uma frase." }],
  })
  .withResponse();

const conversationId = response.headers.get("x-conversation-id")!;
console.log(data.choices[0].message.content);

const next = await client.chat.completions.create(
  {
    model: "claude",
    messages: [{ role: "user", content: "Agora dê um exemplo." }],
  },
  {
    headers: { "X-Conversation-Id": conversationId },
  },
);
console.log(next.choices[0].message.content);
```

Sem `X-Conversation-Id`, cada chamada cria uma nova conversa e aceita o histórico completo. Com o cabeçalho, envie somente mensagens `user` novas. O servidor retoma a sessão nativa e devolve o mesmo cabeçalho, inclusive em streaming. Esse cabeçalho é uma extensão local, não faz parte da API OpenAI.

Sem o campo `model`, a chamada usa Gemini 3.8 Flash low (`antigravity/gemini-3.8-flash-low`). Essa omissão é uma extensão local; a API OpenAI exige `model`. O alias `codex` continua usando Luna por padrão. O modelo usado quando `model` é omitido acompanha `providers.antigravity.defaultModel` de `config.json`.

Os aliases `codex`, `claude`, `antigravity` e `gemini` usam o padrão do provedor ou `defaultModel` da configuração. `gemini` aponta para Antigravity. Para escolher um modelo específico, use `provedor/modelo`, com um ID listado em `GET /v1/models`.

Uma conversa mantém seu provedor e modelo. A configuração `defaultModel` deve constar em `models`. Para fixar um modelo também nas retomadas, configure um padrão explícito antes de iniciar as conversas.

## Streaming

```ts
const { data: stream, response } = await client.chat.completions
  .create({
    model: "codex",
    messages: [{ role: "user", content: "Explique promises." }],
    stream: true,
    stream_options: { include_usage: true },
  })
  .withResponse();

console.log(response.headers.get("x-conversation-id"));
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

A saída usa SSE, chunks `chat.completion.chunk`, `finish_reason` e `[DONE]`. Usage é retornado quando o provedor o informa; não estimamos contagens ausentes. Codex pode entregar o texto em blocos completos, dependendo dos eventos oferecidos pelo SDK. Erros depois do início do stream aparecem como `data: {"error": ...}` e encerram a conexão sem `[DONE]` de sucesso.

## Configuração e persistência

```text
~/.llm-server/
├── config.json
└── providers/
    ├── codex/{workspace,conversations}/
    ├── claude/{workspace,conversations}/
    └── antigravity/{workspace,conversations}/
```

`LLM_SERVER_HOME` permite mudar esse diretório. Arquivos de conversa têm permissão `0600` e diretórios novos `0700`. O registro é escrito por troca atômica e contém ID local, ID nativo, mensagens e estado da chamada. Credenciais permanecem nos diretórios/keychains dos clientes oficiais. Os clientes também persistem suas sessões nos locais nativos; o gateway não move nem copia essas credenciais.

Configuração inicial:

```json
{
  "port": 10434,
  "timeoutMs": 120000,
  "providers": {
    "codex": {
      "enabled": true,
      "defaultModel": "gpt-6-luna",
      "models": ["gpt-6-luna"]
    },
    "claude": { "enabled": true, "models": [] },
    "antigravity": {
      "enabled": true,
      "defaultModel": "gemini-3.8-flash-low",
      "models": ["gemini-3.8-flash-low"]
    }
  }
}
```

Há uma execução ativa por provedor e até 32 chamadas aguardando. O timeout inclui a fila. Desconectar o cliente cancela a geração. Chamadas interrompidas deixam a conversa marcada e sua retomada retorna `409`, pois o estado nativo pode ter avançado sem confirmação local. Inicie uma nova conversa, enviando o histórico desejado. Desative retries automáticos do cliente para evitar gerações duplicadas em falhas de rede.

Execute uma única instância por diretório de dados. As filas são locais ao processo.

## Antigravity e ferramentas

Claude usa `tools: []`, sem MCP, skills ou hooks do usuário. Codex executa em sandbox de leitura, sem shell/unified exec, pesquisa web, apps e configurações pessoais; preserva o login. Não usamos flags de bypass de aprovação.

Antigravity usa um agente de texto exclusivo do workspace do gateway, criado em `~/.llm-server/providers/antigravity/workspace/.agents/agents/llm-server-text/agent.md`. O adaptador seleciona esse agente com `--agent llm-server-text`, com `tools: []`, `commandExecutionPolicy: off`, sem MCP, skills ou plugins, além de `--mode plan --sandbox`.

O servidor não exige nem altera as permissões globais do seu CLI. O controle depende do suporte a agentes personalizados do `agy`; ferramentas internas de gerenciamento podem continuar disponíveis. A primeira chamada e a retomada são verificadas por `npm run smoke -- antigravity`. Para conferir as ferramentas com um arquivo sintético no workspace, execute `npm exec -- tsx scripts/check-antigravity-tools.ts`.

## Compatibilidade

Endpoints: `GET /health`, `GET /v1/models` e `POST /v1/chat/completions`.

Aceita `model`, `messages`, `stream` e `stream_options.include_usage`. Mensagens podem ter conteúdo string ou partes `{ "type": "text", "text": "..." }`. Roles: `system`, `developer`, `user`, `assistant`; a última mensagem precisa ser `user`.

O histórico e suas roles são entregues aos agentes como contexto textual estruturado. SDKs de agentes não expõem as mesmas primitivas de roles da API de inferência; a equivalência semântica de `system`/`developer` não é garantida.

Parâmetros sem suporte, como `temperature`, `max_tokens`, ferramentas e imagens, retornam `400`. Não há Responses API, embeddings, áudio, API nativa Ollama, Anthropic Messages ou Gemini generateContent. O objetivo é compatibilidade de cliente para texto e streaming, não reprodução integral das APIs comerciais.

O terminal registra cada chamada em uma linha JSON com horário UTC, método, rota, provedor/modelo quando resolvido, status HTTP, resultado e duração em milissegundos. Em streaming, o status HTTP pode ser `200` mesmo com falha posterior; consulte `outcome` e `error`. Desconexões aparecem como `disconnected`. Não registra corpo, headers ou parâmetros da URL. Erros externos são convertidos em mensagens fixas, sem imprimir prompts, credenciais ou respostas. Os SDKs/CLIs mantêm seus próprios arquivos nativos conforme sua implementação.

## Verificar

```sh
npm test
npm run typecheck
npm run format:check
npm run build
npm run smoke -- codex claude
npm run smoke -- antigravity
```

Testes automáticos cobrem o SDK OpenAI, SSE, persistência e retomada após reinício, validação, erros sanitizados, isolamento de conversas, timeout, desconexão e filas. Smoke usa prompts sintéticos, consome os limites da assinatura e valida primeira chamada e memória na retomada.

Referências: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), [Antigravity headless](https://antigravity.google/docs/cli/headless/), [Permissões Antigravity](https://antigravity.google/docs/permissions?tab=cli), [Chat Completions](https://developers.openai.com/api/reference/resources/chat).
