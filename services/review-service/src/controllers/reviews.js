// reviews.js — queue · claim · score/flag · my reviews · release
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing
// TODO:
//   - claim: max 5 active claims, conditional update submitted→under_review (409 if taken)
//   - score: every rubric criterion 0–10, no extras; server computes totalScore = Σ(score×weight)/10
//   - flag: reason enum + note ≤ 500; status → reviewed, flagged=true
//   - only the claimer may view/score/release; submitted review is final
