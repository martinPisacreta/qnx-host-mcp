#include <stdio.h>

int main(void)
{
    return puts("Hello from QNX MCP smoke.") == EOF ? 1 : 0;
}
