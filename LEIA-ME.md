# Ficha de Padronização Assistencial de Atendimento ao Politraumatizado

PS Cirurgia Geral · Hospital São Paulo · Escola Paulista de Medicina – UNIFESP

© Outubro de 2026 — **Lucas Domingos Ribeiro** e **Marcos Vinícius Veanholi**
Orientação: **Prof. Dr. Diego Adão**

---

App offline para iPad e celular

App de página única. Funciona sem internet, guarda os casos no próprio aparelho e
exporta CSV no fim do plantão.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | O app inteiro — interface, lógica e dados |
| `manifest.json` | Faz o iPad tratar como aplicativo (ícone, tela cheia) |
| `sw.js` | Service worker: garante abertura sem rede |
| `icon.svg` | Ícone da tela de início |
| `logo-epm.png`, `logo-unifesp.png` | Logos oficiais (opcionais — você adiciona) |

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

1. Paciente entrou na sala → abrir o app → **+ Paciente chegou — novo caso** (grava a Porta).
2. Durante o atendimento: tocar **AGORA** a cada evento. Só isso.
3. No huddle de 60 segundos antes de o paciente sair: completar as demais abas.
4. Depois, com laudo e desfecho: abrir o caso e preencher a aba **Pós**;
   tocar em **Fechar caso**.
5. Fim do plantão ou uma vez por semana: **Casos → Exportar dados → Baixar CSV**.
   Guardar o arquivo e importar no REDCap.

## Novidades da versão 26 — sincronização ligada

- Projeto Firebase **ficha-politrauma-hsp** criado (Firestore em São Paulo, login por e-mail/senha).
- Regras: só lê/grava quem estiver logado **com e-mail confirmado** e na lista autorizada
  (hoje: ldribeiro@unifesp.br e ps.cirurgia.epm@gmail.com — conta da equipe). Para incluir alguém: Firebase → Firestore → Regras → acrescente
  o e-mail na lista entre colchetes → Publicar.
- No app (☁︎ entrar): **Criar conta** (envia link de confirmação), **Entrar**, **Esqueci a senha**.
  Sem confirmar o e-mail, nada sincroniza.

## Novidades da versão 25 — pendências na saída

- Aba Saída: **Aguarda exames laboratoriais** e/ou **Aguarda exames de imagem** (pode marcar
  os dois), cada um com campo opcional de quais exames.
- CSV: `saida_aguarda`, `aguarda_lab`, `aguarda_img`.

## Novidades da versão 24 — sangue total em destaque

- Bloco **SANGUE TOTAL** no topo da aba Hemostasia (disponível no PS do HSP), com o botão
  **ACIONAR SANGUE TOTAL**. Acionado, o bloco fica vermelho e brilhante, grava a hora sozinho
  e abre: unidades transfundidas, tipo (O+, O−, isogrupo), hora da 1ª unidade e reação transfusional.
- Novo cartão "Sangue total acionado" no relógio (aba Horários) — tocar nele também aciona.
- Casos com sangue total ganham a etiqueta 🩸 na lista.
- CSV: `st_acionado`, `h_st`, `t_st`, `st_tipo`, `st_primeira`, `st_reacao`.

## Novidades da versão 23 — sinais vitais ausentes (PCR)

- Em iMIST-AMBO → S, escolha **Presentes** (campos de PA, FC, FR, SpO2, GCS) ou **Ausentes**.
- Ausentes abre o bloco de PCR: **chegou em PCR?** (sim / RCE antes da chegada),
  **foi assistida?** (presenciada pelo APH: sim / não / não informado) e **parado(a) há quanto
  tempo** (minutos ou desconhecido).
- CSV: `cena_sv`, `pcr_chegada`, `pcr_assistida`, `pcr_tempo_min`.
- Ajustes de tela: abas fixas logo abaixo da barra superior (antes ficavam escondidas atrás
  dela ao rolar) e botões que esticavam na pergunta de torso e no bloco de cálcio.

## Novidades da versão 22 — créditos

- Subtítulo: Escola Paulista de Medicina – UNIFESP.
- Rodapé da tela inicial com © outubro de 2026, autores (Lucas Domingos Ribeiro e
  Marcos Vinícius Veanholi) e orientação (Prof. Dr. Diego Adão). Créditos também no
  cabeçalho do código-fonte e neste LEIA-ME.

## Novidades da versão 21 — identidade visual

- Tema escuro no mesmo padrão do Logbook: abas sublinhadas, rótulos em caixa alta, cartões
  de resumo (casos, em aberto, fechados, neste mês) na tela inicial.
- Título: **Ficha de Padronização Assistencial de Atendimento ao Politraumatizado** —
  Escola Paulista de Medicina · PS Cirurgia Geral, Hospital São Paulo.
- **Logos**: coloque os arquivos oficiais na raiz do repositório com os nomes
  `logo-epm.png` e `logo-unifesp.png` (ou `.svg`). Aparecem na capa e no topo (no celular,
  só na capa). Sem os arquivos, o espaço some e nada quebra; ficam disponíveis offline.

## Novidades da versão 20 — indicações de TC e contraste

- Aba **Pós → Tomografia** com as indicações da avaliação secundária:
  - **TC de corpo inteiro**: mecanismo (atropelamento, colisão > 50 km/h, capotamento/ejeção,
    morte de passageiro, queda > 3 m ou desconhecida, explosão, compressão torácica,
    circunstâncias desconhecidas), sinais vitais iniciais (Glasgow < 10, PAS < 80, FR < 10 ou
    > 29, SatO2 < 90% ou < 85% acima de 75 anos) e padrão de lesão (tórax instável, anel
    pélvico instável, > 1 osso longo, amputação proximal).
  - **TC por segmento**: crânio/cervical, tórax (RX de entrada) e abdome/pelve.
- O que já está na ficha é marcado sozinho ("· auto"): atropelamento, velocidade, ejeção,
  óbito no local, altura da queda, Glasgow, PAS, FR, SatO2 (cena ou admissão), pelve instável,
  idade, anticoagulante, FAST+. O restante é tocado à mão.
- **Protocolo de contraste**: split-bolus, trifásico, excretor tardio (combináveis) ou sem contraste.
- CSV: `_tcci_indicada`, `_tcci_criterios`, `_tcseg_criterios`, `tc_contraste`.

## Novidades da versão 19 — RABT: penetrante em torso

- O critério do RABT agora é **ferimento penetrante em torso** (tórax, abdome, flanco,
  dorso ou pelve). Penetrante em membro, cabeça ou pescoço não pontua.
- Quando o trauma é penetrante, a ficha pergunta "É em TORSO? Sim/Não" no Mecanismo e no
  RABT (mesmo campo). Sem resposta, o critério não pontua e aparece aviso.
- Critérios do RABT descritos por extenso na aba Hemostasia. CSV: coluna `rabt_torso`.
- No RABT, basta tocar em **Ferimento penetrante em torso** (o botão de "tipo não registrado
  na Cena" saiu). Só não pontua se a Cena registrou trauma contuso.

## Novidades da versão 18 — ácido tranexâmico e cálcio

- Esquemas de ácido tranexâmico do serviço: **1 g IV em 10 min + 1 g IV em dripping**,
  **2 g IV em bolus**, **1 g IV em bolus** (e Outro, com descrição). Casos antigos convertidos.
- **Reposição de cálcio** logo abaixo do acionamento do PTM: 1 ampola de cloreto de cálcio 10%
  (preferencial) para cada 2 concentrados de hemácias; gluconato de cálcio 10% na falta
  (1 ampola de cloreto ≈ 3 de gluconato em cálcio elementar).
  O app calcula as ampolas indicadas a partir das hemácias e compara com as feitas.
- CSV: `calcio_tipo`, `calcio_ampolas`, `calcio_reposto_sala`, `atx_outro`.

## Novidades da versão 17 — E-FAST-PLUS, sem NEXUS

- Bloco NEXUS retirado. A aba passou a se chamar **E-FAST**.
- **E-FAST-PLUS**: distância da sínfise púbica em cm (ou NR), na letra C e na aba E-FAST.
  **> 1,0 cm = pelve instável** (fratura em livro aberto): campo vermelho, alerta para cinta
  pélvica e sangramento retroperitoneal; > 2,5 cm acrescenta aviso de lesão ligamentar posterior.
- Pelve instável torna a C ALTERADA (texto escrito sozinho) e marca o critério "fratura de
  pelve" do RABT. Marcação manual no RABT prevalece.
- CSV: coluna `efast_sinfise_cm`.

## Novidades da versão 16 — E-FAST detalhado

- **LS por hemitórax**: direito e esquerdo, cada um Positivo / Negativo / NR, e o atalho
  **Bilateral — positivo em ambos**. LS negativo fica vermelho e alerta para pneumotórax.
- **FAST por janela**: hepatorrenal, pericárdica, esplenorrenal e pélvica. Janela positiva
  fica **vermelha na hora**, com alerta de sangramento (ou de tamponamento, na pericárdica).
- O resultado global do FAST e o LS resumido são calculados sozinhos a partir dos detalhes:
  qualquer janela positiva = FAST positivo; todas negativas/NR = negativo.
- NORMAL na B exige os dois hemitórax; na C, as quatro janelas.
- Os mesmos blocos aparecem na letra (B e C) e na aba FAST/NEXUS.
- CSV: `efast_ls_d`, `efast_ls_e`, `fast_*` por janela e `efast_janelas_pos`.

## Novidades da versão 15 — LS e FAST exigem o exame

- A frase da B mostra "LS __" e a da C "FAST __" até o exame ser feito: nada é presumido.
- Seletor dentro da própria letra: **LS** (Positivo / Negativo / Não realizado) na B e
  **FAST** (Negativo / Positivo / Não realizado) na C. São os mesmos campos da aba FAST.
- Sem o resultado marcado, NORMAL fica bloqueado na B e na C.
- LS negativo (com lado) torna a B ALTERADA e escreve o achado; FAST positivo faz o mesmo na C.
- Nota colada com "LS+" / "LS-" preenche o LS. Novas colunas `efast_ls` e `efast_ls_lado`.

## Novidades da versão 14 — frases-padrão do serviço

- Frases de NORMAL do X-ABCDE substituídas pelas do serviço (CC + PR na A; E-FAST com LS+
  na B; BCNF e FAST na C; Glasgow decomposto na D; coluna e ossos longos na E).
- FR, SO2, PA, FC, Glasgow (O/V/M) e resultado do FAST entram sozinhos na frase, em negrito,
  a partir da Admissão e do FAST. Sem valor, aparece "__".
- Campo **Alterações** sempre visível em cada letra. Escrever nele marca ALTERADO na hora.
- Alerta se C estiver NORMAL com FAST positivo, ou D NORMAL com Glasgow < 15.

## Novidades da versão 13 — X-ABCDE normal/alterado

- Cada letra tem dois botões lado a lado: **NORMAL** (verde) e **ALTERADO** (vermelho).
  ALTERADO abre o campo de descrição; a letra fica com borda vermelha.
- Os dois se excluem. Marcar NORMAL numa letra com descrição pede confirmação e apaga o texto.
- CSV ganha `_status_x`, `_status_a`… com "normal", "alterado" ou vazio (não avaliado).

## Novidades da versão 12 — Glasgow descrito

- Cada ponto do Glasgow mostra o nome e a descrição (revisão de 2014), do maior para o
  menor: ex. **M 6 · Obedece a comandos**. No celular, os três itens ficam empilhados.
- O total aparece decomposto e com a gravidade: "Glasgow 9 (O2 V3 M4) — TCE moderado".
  ≤ 8 sugere considerar via aérea definitiva.
- Os valores salvos e exportados continuam os mesmos (1 a 6); nada muda no CSV.

## Novidades da versão 11 — alta velocidade

- Critério escrito na tela: **> 50 km/h para carros · > 32 km/h para motos**.
- Com Colisão auto ou moto marcada, aparece **Velocidade estimada (km/h)**. Informada a
  velocidade, o agravante "Alta velocidade" é marcado (ou desmarcado) sozinho. Auto + moto
  juntos: vale o limite da moto. Marcação manual prevalece.
- Preenchimento assistido lê "80 km/h" da nota. Nova coluna `velocidade` no CSV.

## Novidades da versão 10 — mecanismos combinados

- **Mecanismo agora aceita vários ao mesmo tempo** (ex.: Colisão auto + Colisão moto;
  FAF após colisão). "Moto" passou a se chamar "Colisão moto"; casos antigos são convertidos.
- Mecanismo misto (penetrante + contuso) mostra alerta pedindo o **tipo predominante**,
  que é o que define RABT e TRISS. Sem escolha, o app assume penetrante.
- Preenchimento assistido marca todos os mecanismos citados na nota ("colisão auto x moto"
  → os dois). "Queda de moto" conta como moto, não como queda de altura.
- CSV ganha uma coluna 0/1 por mecanismo (`_mec_colisao_auto`, `_mec_colisao_moto`…),
  no formato de checkbox do REDCap. A coluna `mecanismo` continua, separada por " | ".

## Novidades da versão 9 — relógio automático

- **Porta (chegada) é automática:** gravada no instante em que se toca
  "+ Paciente chegou — novo caso". Abra o caso quando o paciente entrar na sala,
  não na pré-notificação. Se abriu antes, use "desfazer" na Porta e toque na chegada.
- **Trauma** é o único horário digitado (seletor de hora; ou "Desconhecido").
- Todos os outros: **um toque no cartão grava a hora do aparelho**. Não há mais edição
  manual (✎) — o horário é sempre o do clique. Toque duplo não sobrescreve.
- Cada toque guarda também o carimbo completo com segundos (`_ts_h_*` no CSV), para auditoria.
- Toque por engano: **desfazer** (pede confirmação) e tocar de novo na hora certa.
- Marcar Ácido tranexâmico, PTM ou TC preenche sozinho "Feito", "Acionado" e "Sim" nas
  abas correspondentes (só se estiverem vazias; desfazer reverte).
- Alerta quando o horário do trauma ficar depois da chegada.

## Novidades da versão 8 — casos que não somem

- **Correção de perda de dado:** aspas ou `<` digitados num campo quebravam o valor ao
  trocar de aba (parecia que "não salvou"). Agora todo texto é escapado.
- **Duas abas/janelas abertas** não se sobrescrevem mais: cada gravação relê o que está
  salvo e mescla caso a caso (vence a edição mais recente).
- **Avisos na tela de casos:** aba privada (nada é guardado), Safari em vez do ícone da
  Tela de Início (no iOS são armazenamentos separados, e o Safari apaga dados de sites
  após 7 dias sem uso) e lembrete de backup quando não há nuvem.
- `navigator.storage.persist()` pede ao navegador para não descartar os dados.
- **Importar backup JSON** (Exportar dados → Importar backup): mescla, nunca substitui,
  e importar o mesmo arquivo duas vezes não duplica casos.
- **Sigla do aparelho** (botão ☁︎): `TR-2026-IP1-0001`. Sem ela, dois iPads offline geram
  o mesmo número. Decida com a equipe antes de usar — muda o formato do código do estudo.
- Apagar deixa uma "lápide" interna, para o caso não ressuscitar vindo de outro aparelho.
- **Sincronização opcional entre aparelhos (Firebase)**, offline-first: salva no aparelho
  na hora e sobe sozinho quando há rede.

## Ligar a sincronização (uma vez, ~15 min)

1. https://console.firebase.google.com → Criar projeto (Analytics desnecessário).
2. **Authentication → Método de login → E-mail/senha: ativar.** Em *Usuários*, crie uma
   conta por membro da equipe (ou uma conta por iPad).
3. **Firestore Database → Criar banco** (região `southamerica-east1`, São Paulo).
4. Em **Regras**, cole e publique (troque os e-mails):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /casos/{id} {
      allow read, write: if request.auth != null
        && request.auth.token.email in ['residente1@unifesp.br', 'residente2@unifesp.br'];
    }
  }
}
```

5. **Configurações do projeto → Seus apps → Web (</>)** → copie o objeto `firebaseConfig`
   e cole no `index.html`, no lugar de `const FIREBASE_CONFIG = null;`.
   Esses valores não são segredo; quem protege os dados são as regras do passo 4.
6. Publique no GitHub. Em cada aparelho: abra pelo ícone → ☁︎ entrar.

Antes de ligar, faça **Backup JSON** em cada aparelho; depois de entrar, os casos locais
sobem sozinhos (ou use *Importar backup*).

Limite conhecido: se duas pessoas editarem **o mesmo caso ao mesmo tempo**, vale a versão
salva por último (o caso inteiro, não campo a campo). Na prática: um aparelho por caso.

Aspecto ético/LGPD: continua sem identificador do paciente, mas os dados passam a ficar
num servidor do Google. Vale constar no projeto enviado ao CEP.

## Novidades da versão 7

- **Aba iMIST-AMBO** (antiga Cena), reorganizada na sequência do mnemônico:
  i · M · I · S · T · T · T · AMBO — a tela acompanha a ordem da passagem do APH.
- **Preenchimento assistido**: cole a nota no formato do serviço (# ID, # IMISTTT
  AMBO, # XABCDE) e o app extrai identificação, mecanismo com tipo e altura,
  injúrias, sinais vitais da cena e da admissão, os três T desambiguados
  (transporte / tempo / tratamento, com CC+PR reconhecidos), AMBO, Glasgow
  decomposto e FAST. Funciona offline; preenche só campos vazios; lista tudo
  para conferência.
- **X-ABCDE em três estados a partir da nota**: frase-padrão presente → NORMAL;
  achado descrito → transcrito para o campo "alterado"; sem menção → etiqueta
  PENDENTE na letra, até alguém examinar e preencher.
- **Nome e número de AT são removidos automaticamente** do texto colado —
  nenhum identificador fica no aparelho.
- Validado com bateria automatizada sobre 4 notas reais do serviço:
  118 verificações, 118 corretas.

## Novidades da versão 5

- **Tipo de trauma (contuso/penetrante)** na aba Cena. É fonte única: alimenta
  sozinho o critério "penetrante" do RABT e a escolha de coeficientes do TRISS.
- **Esquema do ácido tranexâmico** quando "Feito" (esquemas atualizados na v18).
- **Peso** na Identificação (estimado, se preciso).
- O preenchimento assistido da passagem iMIST-AMBO foi retirado por decisão da
  equipe; pode voltar numa versão futura.

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
- **RABT** — ferimento penetrante **em torso** (tórax, abdome, flanco, dorso ou pelve), FAST positivo, Shock Index > 1,0 e fratura de
  pelve; FAST e Shock Index vêm sozinhos dos blocos anteriores, com alerta em ≥ 2.
  (Não confundir com o ABC score, que usa PAS ≤ 90 e FC ≥ 120 no lugar do Shock Index.)
- **RTS**, nas duas formas: T-RTS de triagem (0 a 12) e RTS ponderado (0 a 7,8408)
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

- Sem a sincronização ligada, os dados moram no navegador daquele aparelho. Se ele for
  restaurado ou alguém limpar os dados do Safari, some tudo. Backup semanal obrigatório.
- Não é dispositivo médico nem substitui o prontuário. O registro legal continua
  sendo o Tasy.

## Para alterar o app

Tudo está em `index.html`. Os campos de cada aba ficam nas funções `secId`,
`secHorarios`, `secCena`, `secAdmissao`, `secXabcde`, `secFast` (E-FAST), `secHemo`,
`secSaida` e `secPos`. Os horários são a lista `HORARIOS`, e as frases de
normalidade do exame primário estão em `XABCDE`. Ao publicar versão nova,
troque o número em `CACHE` dentro de `sw.js`, senão o iPad continua servindo a
versão antiga do cache.
