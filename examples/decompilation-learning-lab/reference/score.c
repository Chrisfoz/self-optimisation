/* Original teaching fixture, MIT licensed. Not commercial game code. */
int score_tick(int coins, int streak, int hazard) {
    int score = coins * 10;
    if (streak >= 3) score += streak * 2;
    if (hazard) score /= 2;
    return score;
}
