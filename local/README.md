# Executar no computador

## Windows por duplo clique

1. Extraia o ZIP para uma pasta permanente, sem acentos problemáticos ou sincronização parcial.
2. Execute `INSTALAR-NO-WINDOWS.cmd`.
3. O instalador cria uma chave aleatória em `.env`, escolhe Docker Desktop quando disponível ou Node.js 22 como alternativa, compila e testa a saúde do serviço.
4. O painel abrirá em `http://127.0.0.1:8080/dashboard/`.
5. Clique em **Conectar com segurança** e selecione o arquivo `.env` da pasta extraída. O navegador lê a chave somente em memória; ela não é enviada a nenhum site externo.

Use `INICIAR-NO-WINDOWS.cmd`, `PARAR-NO-WINDOWS.cmd`, `STATUS-NO-WINDOWS.cmd` e `TESTAR-NO-WINDOWS.cmd` depois da instalação. A chave não é exibida e `.env` não entra no Git.

Pré-requisito: Docker Desktop em execução **ou** Node.js 22.13 ou superior com `node:sqlite`. O instalador não baixa programas nem pede privilégios de administrador. A primeira instalação precisa de internet para baixar a imagem e/ou as dependências bloqueadas pelo `package-lock.json`.

## Linux ou macOS

```bash
./local/unix/install.sh
./local/unix/start.sh
./local/unix/status.sh
./local/unix/stop.sh
```

O modo local escuta somente em `127.0.0.1`. Para acesso em rede, mantenha o serviço atrás de TLS e de um gateway de identidade; não altere `HOST` para `0.0.0.0` sem esses controles.

O painel oferece um grafo ontológico 2D e uma projeção 3D dos mesmos nós e relações declarados. Não há pulsos nem dados de demonstração. A atividade exibida vem somente de registros persistidos em `runtime/cortex.db` no modo Node ou no volume `cortex-universal-data` no modo Docker, consultados por tenant e cérebro explícitos. A exportação JSON contém apenas a visualização ontológica atualmente filtrada.
