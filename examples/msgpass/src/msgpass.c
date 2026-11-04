/*
 * QNX 8.0 references consulted:
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channelcreate.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/connectattach.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsend.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgreceive.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgreply.html
 */
#include <sys/neutrino.h>
#include <sys/netmgr.h>
#include <pthread.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MESSAGE_COUNT = 3 };

static void fail(const char *call, int error)
{
    fprintf(stderr, "msgpass: %s failed: errno=%d (%s)\n",
            call, error, strerror(error));
    /* A server failure must also terminate a potentially blocked client. */
    exit(EXIT_FAILURE);
}

static void *serve(void *argument)
{
    const int chid = *(const int *)argument;
    int i;

    for (i = 0; i < MESSAGE_COUNT; ++i) {
        /* The receive buffer must also be large enough for a QNX pulse. */
        union {
            struct _pulse pulse;
            int number;
        } request = {0};
        struct _msg_info info;
        rcvid_t rcvid;
        int reply;

        rcvid = MsgReceive(chid, &request, sizeof(request), &info);
        if (rcvid == -1) {
            fail("MsgReceive", errno);
        }
        if (rcvid == 0) {
            fail("MsgReceive (unexpected pulse)", EPROTO);
        }
        if (info.srcmsglen != sizeof(request.number)) {
            fail("MsgReceive (unexpected message size)", EPROTO);
        }

        /* Only this process's client sends the three fixed, small integers. */
        reply = request.number * 2;
        if (MsgReply(rcvid, 0, &reply, sizeof(reply)) == -1) {
            fail("MsgReply", errno);
        }
    }
    return NULL;
}

int main(void)
{
    const int numbers[MESSAGE_COUNT] = {7, 11, 21};
    pthread_t server;
    int chid;
    int coid;
    int error;
    int i;

    /* Private channels support threads in this process without a public channel. */
    chid = ChannelCreate(_NTO_CHF_PRIVATE);
    if (chid == -1) {
        fail("ChannelCreate", errno);
    }

    /* reserved=0, pid=0 selects this process; avoid the file descriptor space. */
    coid = ConnectAttach(0, 0, chid, _NTO_SIDE_CHANNEL, 0);
    if (coid == -1) {
        fail("ConnectAttach", errno);
    }

    error = pthread_create(&server, NULL, serve, &chid);
    if (error != 0) {
        /* pthread functions return the error number instead of setting errno. */
        fail("pthread_create", error);
    }

    for (i = 0; i < MESSAGE_COUNT; ++i) {
        int reply = 0;
        long status = MsgSend(coid, &numbers[i], sizeof(numbers[i]),
                              &reply, sizeof(reply));
        if (status == -1) {
            fail("MsgSend", errno);
        }
        if (status != 0 || reply != numbers[i] * 2) {
            fail("MsgSend (unexpected reply)", EPROTO);
        }
        if (printf("msgpass: sent %d got %d\n", numbers[i], reply) < 0) {
            fail("printf", errno);
        }
    }

    error = pthread_join(server, NULL);
    if (error != 0) {
        fail("pthread_join", error);
    }
    if (ConnectDetach(coid) == -1) {
        fail("ConnectDetach", errno);
    }
    if (ChannelDestroy(chid) == -1) {
        fail("ChannelDestroy", errno);
    }
    if (puts("msgpass: ok") == EOF) {
        fail("puts", errno);
    }
    if (fflush(stdout) == EOF) {
        fail("fflush", errno);
    }
    return EXIT_SUCCESS;
}
