# TRISS

Probabilidade de sobrevida (Ps) combinando [[RTS]] ponderado, [[ISS]] e idade.

Ps = 1 / (1 + e^−b), com b = b0 + b1·RTS + b2·ISS + b3·(índice de idade)

Coeficientes do MTOS (Boyd, 1987):
- Contuso: b0 −1,2470 · b1 0,9544 · b2 −0,0768 · b3 −1,9052
- Penetrante: b0 −0,6029 · b1 1,1430 · b2 −0,1516 · b3 −2,6676

Índice de idade: 0 abaixo de 55 anos, 1 a partir de 55. Menores de 15 anos usam os coeficientes de contuso, por convenção. O mecanismo vem do [[Tipo de trauma]] e pode ser forçado manualmente.

Esses coeficientes são de 1987 e superestimam mortalidade em casuísticas atuais: servem como descritor de gravidade da amostra e para comparar com a literatura — não como prognóstico individual à beira do leito.

Colunas `_triss_ps` e `_triss_coef`.
