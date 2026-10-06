# Preenchimento assistido

Na aba iMIST-AMBO: colar (ou ditar) a nota no formato do serviço — blocos # ID, # IMISTTT AMBO, # XABCDE — e tocar em "Preencher campos a partir do texto".

O parser extrai: identificação, mecanismo com tipo e altura, injúrias, sinais vitais da cena e da admissão, os três T desambiguados (transporte / tempo / tratamento, com CC+PR reconhecidos), AMBO, Glasgow decomposto e FAST.

Regras:
- funciona offline, por regras de texto
- preenche só campos vazios e lista tudo para conferência
- nome e número de AT são removidos automaticamente do texto colado — nenhum identificador fica no aparelho
- [[XABCDE]] em três estados: NORMAL, alterado ou PENDENTE

Validado com bateria automatizada sobre 4 notas reais do serviço: 118 verificações, 118 corretas. Ver [[iMIST-AMBO]] e [[Regras do app]].
