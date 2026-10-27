#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/syscall.h>
int main(int c, char **v) {
    int fd = open(v[1], O_RDONLY);
    if (fd < 0) { printf("open failed: %s\n", strerror(errno)); return 2; }
    if (syscall(SYS_finit_module, fd, "", 0) == 0) { printf("LOADED\n"); return 0; }
    printf("REFUSED: %s (errno %d)\n", strerror(errno), errno); return 1;
}
