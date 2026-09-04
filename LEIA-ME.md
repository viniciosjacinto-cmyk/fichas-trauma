# Ficha de Trauma — app offline para iPad

App de página única. Funciona sem internet, guarda os casos no próprio aparelho e
exporta CSV no fim do plantão.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | O app inteiro — interface, lógica e dados |
| `manifest.json` | Faz o iPad tratar como aplicativo (ícone, tela cheia) |
| `sw.js` | Service worker: garante abertura sem rede |
| `icon.svg` | Ícone da tela de início |

## Como colocar no iPad

O caminho confiável é publicar os quatro arquivos em qualquer endereço HTTPS
e abrir esse endereço no Safari. Gratuito e suficiente: GitHub Pages.

1. Crie um repositório no GitHub e envie os quatro arquivos na raiz.
2. Settings → Pages → Source: branch `main`, pasta `/root`. Salve.
3. Em poucos minutos sai um endereço `https://<usuário>.github.io/<repo>/`.
4. No iPad, abra esse endereço no **Safari** (não no Chrome — no iOS só o Safari instala).
5. Botão Compartilhar → **Adicionar à Tela de Início**.
6. Abra o app pelo ícone uma vez com internet. A partir daí funciona offline.

Abrir o `index.html` direto pelo app Arquivos até funciona, mas o iOS trata cada
abertura como origem diferente e **os casos podem sumir**. Não use esse caminho
para coleta real.

## Configuração do iPad antes de usar na sala

- **Acesso Guiado** (Ajustes → Acessibilidade → Acesso Guiado): trava o aparelho
  no app. Impede que alguém saia da ficha no meio do atendimento.
- **Data e Hora em ajuste automático** (Ajustes → Geral → Data e Hora). Com o app
  em uso, o relógio do iPad é o relógio oficial do atendimento — quem anotar no
  papel de backup deve copiar a hora do iPad, nunca do relógio de parede ou do
  próprio celular. Misturar fontes de horário corrompe todos os intervalos do estudo.
- **Bloqueio automático: Nunca** (Ajustes → Tela e Brilho). Tela apagando no meio
  da reanimação é o jeito mais rápido de matar a adesão.
- Capa que aguente álcool.
- Carregador fixo na sala.

## Rotina de uso

1. Código vermelho ativado → abrir o app → **+ Novo código vermelho**.
2. Durante o atendimento: tocar **AGORA** a cada evento. Só isso.
3. No huddle de 60 segundos antes de o paciente sair: completar as demais abas.
4. Depois, com laudo e desfecho: abrir o caso e preencher a aba **Pós**;
   tocar em **Fechar caso**.
5. Fim do plantão ou uma vez por semana: **Casos → Exportar dados → Baixar CSV**.
   Guardar o arquivo e importar no REDCap.

## Regras que o app assume

- **Nenhum identificador do paciente entra no aparelho.** Só o código do estudo
  (`TR-2026-0001`, gerado automaticamente). A ligação entre código e prontuário
  fica no caderno de triagem da sala.
- Horário vazio e horário marcado como `N/A` são coisas diferentes na exportação —
  vazio é falha de registro, `N/A` é decisão consciente.
- O papel continua na sala como plano B. iPad descarregado, emprestado ou travado
  não pode significar caso perdido.

## O que o app calcula sozinho

Imediato, sem digitar nada além dos sinais vitais:

- Glasgow total, a partir de O + V + M
- **Shock Index**, com alerta quando ≥ 1,0
- **RABT** — mecanismo penetrante, FAST positivo, Shock Index > 1,0 e fratura de
  pelve; FAST e Shock Index vêm sozinhos dos blocos anteriores, com alerta em ≥ 2.
  (Não confundir com o ABC score, que usa PAS ≤ 90 e FC ≥ 120 no lugar do Shock Index.)
- **RTS**, nas duas formas: T-RTS de triagem (0 a 12) e RTS ponderado (0 a 7,8408)
- Resultado do NEXUS e a conduta correspondente sobre o colar
- Janela do ácido tranexâmico: minutos desde o trauma e quanto resta
- Intervalos porta–TC, porta–transfusão, porta–CC, tempo de sala, trauma–tranexâmico

Depois, com laudo definitivo:

- **ISS**, a partir do AIS das seis regiões — soma dos quadrados dos três maiores,
  com a regra de AIS 6 forçando ISS 75. O app avisa quando faltam regiões pontuadas,
  porque região em branco conta como zero e subestima o escore.
- **TRISS**, probabilidade de sobrevida, combinando RTS ponderado, ISS e idade.

### Detalhes dos escores

**RTS** usa os valores codificados de Champion: Glasgow (13–15→4, 9–12→3, 6–8→2,
4–5→1, 3→0), PA sistólica (>89→4, 76–89→3, 50–75→2, 1–49→1, 0→0) e frequência
respiratória (10–29→4, >29→3, 6–9→2, 1–5→1, 0→0). O ponderado é
0,9368·GCS + 0,7326·PAS + 0,2908·FR. Vale sempre a **primeira** aferição, antes
de qualquer reposição — valor pós-reanimação infla o escore e enviesa o TRISS.

**TRISS** usa os coeficientes do MTOS (Boyd, 1987): contuso b0 = −1,2470,
b1 = 0,9544, b2 = −0,0768, b3 = −1,9052; penetrante b0 = −0,6029, b1 = 1,1430,
b2 = −0,1516, b3 = −2,6676. Índice de idade 0 abaixo de 55 anos, 1 a partir de 55.
Menores de 15 anos usam os coeficientes de contuso, por convenção. O mecanismo é
deduzido do que foi registrado em Cena, e dá para forçar manualmente.

Esses coeficientes são de 1987 e superestimam mortalidade em casuísticas atuais.
Servem como descritor de gravidade da amostra e para comparação com a literatura —
não como prognóstico individual à beira do leito.

Todos os escores saem no CSV em colunas próprias, prefixadas com `_`:
`_rts_t`, `_rts_ponderado`, `_iss`, `_triss_ps`, `_triss_coef`, `_shock_index`, `_rabt`.

## Exportação

`Exportar dados` abre uma janela com três saídas:

- **Copiar** — cola direto numa planilha
- **Baixar CSV** — separador ponto e vírgula, com BOM (abre certo no Excel em português)
- **Backup JSON** — cópia integral, para não depender de um aparelho só

Exporte **antes** de qualquer atualização do app e antes de limpar dados do Safari.

## Limitações honestas

- Os dados moram no navegador daquele iPad. Se o aparelho for restaurado ou
  alguém limpar os dados do Safari, some tudo. Por isso o backup semanal não é opcional.
- Não há sincronização entre aparelhos nem login. É captura local, com exportação
  manual para o REDCap.
- Não é dispositivo médico nem substitui o prontuário. O registro legal continua
  sendo o Tasy.

## Para alterar o app

Tudo está em `index.html`. Os campos de cada aba ficam nas funções `secId`,
`secHorarios`, `secCena`, `secAdmissao`, `secXabcde`, `secFast`, `secHemo`,
`secSaida` e `secPos`. Os horários são a lista `HORARIOS`, e as frases de
normalidade do exame primário estão em `XABCDE`. Ao publicar versão nova,
troque o número em `CACHE` dentro de `sw.js`, senão o iPad continua servindo a
versão antiga do cache.
