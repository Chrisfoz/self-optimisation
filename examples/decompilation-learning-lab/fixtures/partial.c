/* Scripted replay proposal: handles the combo but misses the hazard. */
int score_tick(int coins, int streak, int hazard) {
    int score = coins * 10;
    if (streak >= 3) score += streak * 2;
    return score;
}
