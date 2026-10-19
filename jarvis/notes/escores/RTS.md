# RTS

Revised Trauma Score, com os valores codificados de Champion. Cada componente vale de 0 a 4.

Glasgow: 13–15 → 4 · 9–12 → 3 · 6–8 → 2 · 4–5 → 1 · 3 → 0
PA sistólica: > 89 → 4 · 76–89 → 3 · 50–75 → 2 · 1–49 → 1 · 0 → 0
Frequência respiratória: 10–29 → 4 · > 29 → 3 · 6–9 → 2 · 1–5 → 1 · 0 → 0

Duas formas:
- T-RTS (triagem) = soma simples, de 0 a 12. RTS ≤ 10 costuma indicar necessidade de centro de trauma.
- RTS ponderado = 0,9368·GCS + 0,7326·PAS + 0,2908·FR, de 0 a 7,8408. É o que alimenta o [[TRISS]].

Vale sempre a PRIMEIRA aferição, antes de qualquer reposição: valor pós-reanimação infla o escore e enviesa o TRISS. Ver [[Sinais vitais da admissão]] e [[Glasgow]].

Colunas no CSV: `_rts_t` e `_rts_ponderado`.
