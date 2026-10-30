---
'@eventkit/sdk': minor
---

Multi-select and date-time questions, submission deadlines and the event-day gate (needs eventkit-core 0.11.0). `Answers` and `Draft` values may be lists (`multi_choice`); `toAnswers` sends date-time drafts (`<input type="datetime-local">` values) as IST with their offset, and `toDraft(answers, fields)` fills them back. New `toggleOption` and `answerText`. Submissions carry `deadline` and entries `late`; portal info and `me` carry `activitiesFrom`, and `me.activitiesOpen` says whether polls, submissions and the leaderboard are open yet.
