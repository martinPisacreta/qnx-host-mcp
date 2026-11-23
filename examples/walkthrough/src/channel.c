#include <stdio.h>
#include <stdlib.h>
#include <sys/neutrino.h>

int main(void)
{
    int chid = ChannelCreate(_NTO_CHF_DISCONNECT);
    if (chid == -1) {
        perror("ChannelCreate");
        return EXIT_FAILURE;
    }
    printf("Channel created: chid=%d\n", chid);
    if (ChannelDestroy(chid) == -1) {
        perror("ChannelDestroy");
        return EXIT_FAILURE;
    }
    puts("Walkthrough program finished.");
    return EXIT_SUCCESS;
}
