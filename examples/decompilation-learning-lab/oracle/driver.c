#include <stdio.h>
int score_tick(int coins, int streak, int hazard);
int main(void) {
    int coins, streak, hazard;
    while (scanf("%d %d %d", &coins, &streak, &hazard) == 3) {
        if (coins < 0 || coins > 7 || streak < 0 || streak > 7 || hazard < 0 || hazard > 1) return 2;
        printf("%d\n", score_tick(coins, streak, hazard));
    }
    return 0;
}
