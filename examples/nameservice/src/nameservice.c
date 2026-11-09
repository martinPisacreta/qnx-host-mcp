#include <sys/dispatch.h>
#include <sys/neutrino.h>
#include <sys/iomsg.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { REQUEST_COUNT = 3, OPEN_ATTEMPTS = 50 };

struct request {
    struct _pulse hdr;
    int value;
};

static const int values[REQUEST_COUNT] = {7, 11, 21};
static const int expected[REQUEST_COUNT] = {21, 33, 63};

static void diagnose(const char *call, int error)
{
    fprintf(stderr, "nameservice: %s: %s\n", call, strerror(error));
}

static void run_client(void)
{
    int replies[REQUEST_COUNT] = {0, 0, 0};
    int coid = -1;
    int last_error = ENOENT;
    int failed = 0;
    int attempt;
    int index;

    for (attempt = 0; attempt < OPEN_ATTEMPTS; ++attempt) {
        coid = name_open("automata-name", 0);
        if (coid != -1) {
            break;
        }
        last_error = errno;
        if (attempt + 1 < OPEN_ATTEMPTS && usleep(100000) == -1) {
            diagnose("usleep", errno);
            _exit(1);
        }
    }
    if (coid == -1) {
        diagnose("name_open", last_error);
        _exit(1);
    }

    for (index = 0; index < REQUEST_COUNT; ++index) {
        struct request message = {0};
        long status;

        message.hdr.type = 0;
        message.hdr.subtype = 0;
        message.value = values[index];
        status = MsgSend(coid, &message, sizeof(message),
                         &replies[index], sizeof(replies[index]));
        if (status == -1) {
            diagnose("MsgSend", errno);
            failed = 1;
            break;
        }
        if (status != EOK) {
            diagnose("MsgSend (unexpected status)", EPROTO);
            failed = 1;
        }
        if (replies[index] != expected[index]) {
            failed = 1;
        }
    }
    if (name_close(coid) == -1) {
        diagnose("name_close", errno);
        failed = 1;
    }
    if (failed) {
        fprintf(stderr, "nameservice: client replies=%d,%d,%d\n",
                replies[0], replies[1], replies[2]);
    }
    _exit(failed ? 1 : 0);
}

int main(void)
{
    name_attach_t *attach;
    pid_t child;
    pid_t waited;
    int replies[REQUEST_COUNT] = {0, 0, 0};
    int count = 0;
    int other_process_count = 0;
    int registered;
    int failed = 0;
    int child_status = 0;
    int child_ok = 0;

    attach = name_attach(NULL, "automata-name", 0);
    if (attach == NULL) {
        diagnose("name_attach", errno);
        return EXIT_FAILURE;
    }
    registered = access("/dev/name/local/automata-name", F_OK) == 0;
    if (!registered) {
        diagnose("access", errno);
        if (name_detach(attach, 0) == -1) {
            diagnose("name_detach", errno);
        }
        return EXIT_FAILURE;
    }

    child = fork();
    if (child == -1) {
        diagnose("fork", errno);
        if (name_detach(attach, 0) == -1) {
            diagnose("name_detach", errno);
        }
        return EXIT_FAILURE;
    }
    if (child == 0) {
        /* The child must not detach the parent's registered service. */
        run_client();
        _exit(1);
    }

    while (count < REQUEST_COUNT && !failed) {
        struct request message = {0};
        struct _msg_info info = {0};
        rcvid_t rcvid;

        rcvid = MsgReceive(attach->chid, &message, sizeof(message), &info);
        if (rcvid == -1) {
            if (errno == EINTR) {
                continue;
            }
            diagnose("MsgReceive", errno);
            failed = 1;
            break;
        }
        if (rcvid == 0) {
            switch (message.hdr.code) {
            case _PULSE_CODE_DISCONNECT:
                if (ConnectDetach(message.hdr.scoid) == -1) {
                    diagnose("ConnectDetach", errno);
                    failed = 1;
                }
                /* This standalone example has only one client. */
                if (count < REQUEST_COUNT) {
                    fprintf(stderr, "nameservice: client disconnected after %d data messages\n", count);
                    failed = 1;
                }
                break;
            case _PULSE_CODE_UNBLOCK:
            case _PULSE_CODE_COIDDEATH:
            default:
                break;
            }
            continue;
        }
        if (message.hdr.type == _IO_CONNECT) {
            if (MsgReply(rcvid, EOK, NULL, 0) == -1) {
                diagnose("MsgReply (_IO_CONNECT)", errno);
                failed = 1;
            }
            continue;
        }
        if (message.hdr.type >= _IO_BASE && message.hdr.type <= _IO_MAX) {
            if (MsgError(rcvid, ENOSYS) == -1) {
                diagnose("MsgError (unsupported I/O)", errno);
                failed = 1;
            }
            continue;
        }
        if (message.hdr.type != 0 || message.hdr.subtype != 0 ||
            (size_t)info.srcmsglen != sizeof(message) ||
            (size_t)info.msglen != sizeof(message) ||
            message.value != values[count]) {
            diagnose("MsgReceive (unexpected data)", EPROTO);
            if (MsgError(rcvid, EPROTO) == -1) {
                diagnose("MsgError (unexpected data)", errno);
            }
            failed = 1;
            break;
        }
        replies[count] = message.value * 3;
        if (info.pid != getpid()) {
            ++other_process_count;
        }
        if (MsgReply(rcvid, EOK, &replies[count], sizeof(replies[count])) == -1) {
            diagnose("MsgReply (data)", errno);
            failed = 1;
            break;
        }
        ++count;
    }

    /* On server failure, release a client blocked in MsgSend before waiting. */
    if (failed) {
        if (name_detach(attach, 0) == -1) {
            diagnose("name_detach (failure cleanup)", errno);
        }
        attach = NULL;
    }
    do {
        waited = waitpid(child, &child_status, 0);
    } while (waited == -1 && errno == EINTR);
    if (waited == -1) {
        diagnose("waitpid", errno);
        failed = 1;
    } else {
        child_ok = WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0;
    }
    if (attach != NULL && name_detach(attach, 0) == -1) {
        diagnose("name_detach", errno);
        failed = 1;
    }

    if (failed || !child_ok || count != REQUEST_COUNT ||
        replies[0] != 21 || replies[1] != 33 || replies[2] != 63 ||
        other_process_count != REQUEST_COUNT || !registered) {
        fprintf(stderr,
                "nameservice: replies=%d,%d,%d messages=%d other_pid_messages=%d registered=%d child_ok=%d child_status=%d\n",
                replies[0], replies[1], replies[2], count,
                other_process_count, registered, child_ok, child_status);
        return EXIT_FAILURE;
    }
    if (puts("QNX_NAME_OK replies=21,33,63") == EOF ||
        puts("cross_process=1 registered=1") == EOF) {
        diagnose("puts", errno);
        return EXIT_FAILURE;
    }
    if (fflush(stdout) == EOF) {
        diagnose("fflush", errno);
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
