#include <stdio.h>
#include <unistd.h>

int main(void)
{
    puts("Started; this program never exits on its own.");
    fflush(stdout);
    for (;;) {
        sleep(1);
    }
    return 0;
}
