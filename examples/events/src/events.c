#include <sys/neutrino.h>
#include <pthread.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { EVENT_COUNT = 3, EVENT_VALUE = 7 };

static void fail(const char *call, int error)
{
    fprintf(stderr, "events: %s: %s\n", call, strerror(error));
    /* Terminate both threads if either side could otherwise remain blocked. */
    exit(EXIT_FAILURE);
}

static void *serve(void *argument)
{
    const int notification_chid = *(const int *)argument;
    int server_chid;
    int startup_coid;
    int i;
    long status;
    rcvid_t rcvid;
    struct _msg_info info;
    struct sigevent event;
    struct timespec delay = {0, 50000000L};
    union {
        struct _pulse pulse;
        struct sigevent event;
    } request = {0};

    server_chid = ChannelCreate(0);
    if (server_chid == -1) {
        fail("ChannelCreate (server)", errno);
    }

    /* Publish the server channel through a startup message, without polling. */
    startup_coid = ConnectAttach(0, 0, notification_chid,
                                 _NTO_SIDE_CHANNEL, 0);
    if (startup_coid == -1) {
        fail("ConnectAttach (startup)", errno);
    }
    status = MsgSend(startup_coid, &server_chid, sizeof(server_chid),
                     NULL, 0);
    if (status == -1) {
        fail("MsgSend (startup)", errno);
    }
    if (status != 0) {
        fail("MsgSend (startup status)", EPROTO);
    }
    if (ConnectDetach(startup_coid) == -1) {
        fail("ConnectDetach (startup)", errno);
    }

    rcvid = MsgReceive(server_chid, &request, sizeof(request), &info);
    if (rcvid == -1) {
        fail("MsgReceive (request)", errno);
    }
    if (rcvid == 0 ||
        (size_t)info.srcmsglen != sizeof(request.event) ||
        (size_t)info.msglen != sizeof(request.event)) {
        fail("MsgReceive (unexpected request)", EPROTO);
    }
    event = request.event;
    if (MsgReply(rcvid, 0, NULL, 0) == -1) {
        fail("MsgReply", errno);
    }
    if (MsgVerifyEvent(rcvid, &event) == -1) {
        fail("MsgVerifyEvent", errno);
    }

    while (nanosleep(&delay, &delay) == -1) {
        if (errno != EINTR) {
            fail("nanosleep", errno);
        }
    }
    for (i = 0; i < EVENT_COUNT; ++i) {
        if (MsgDeliverEvent(rcvid, &event) == -1) {
            fail("MsgDeliverEvent", errno);
        }
    }
    return NULL;
}

int main(void)
{
    pthread_t server;
    int notification_chid;
    int notification_coid;
    int server_chid;
    int server_coid;
    int error;
    int received;
    long status;
    rcvid_t startup_rcvid;
    struct _msg_info info;
    struct sigevent event = {0};
    union {
        struct _pulse pulse;
        int server_chid;
    } startup = {0};

    notification_chid = ChannelCreate(0);
    if (notification_chid == -1) {
        fail("ChannelCreate (notifications)", errno);
    }
    notification_coid = ConnectAttach(0, 0, notification_chid,
                                      _NTO_SIDE_CHANNEL, 0);
    if (notification_coid == -1) {
        fail("ConnectAttach (notifications)", errno);
    }
    error = pthread_create(&server, NULL, serve, &notification_chid);
    if (error != 0) {
        fail("pthread_create", error);
    }

    /* Before event registration, this channel receives only the startup ID. */
    startup_rcvid = MsgReceive(notification_chid, &startup,
                                sizeof(startup), &info);
    if (startup_rcvid == -1) {
        fail("MsgReceive (startup)", errno);
    }
    if (startup_rcvid == 0 ||
        (size_t)info.srcmsglen != sizeof(startup.server_chid) ||
        (size_t)info.msglen != sizeof(startup.server_chid)) {
        fail("MsgReceive (unexpected startup)", EPROTO);
    }
    server_chid = startup.server_chid;
    if (MsgReply(startup_rcvid, 0, NULL, 0) == -1) {
        fail("MsgReply (startup)", errno);
    }
    server_coid = ConnectAttach(0, 0, server_chid, _NTO_SIDE_CHANNEL, 0);
    if (server_coid == -1) {
        fail("ConnectAttach (server)", errno);
    }
    SIGEV_PULSE_INIT(&event, notification_coid, SIGEV_PULSE_PRIO_INHERIT,
                     _PULSE_CODE_MINAVAIL, EVENT_VALUE);
    if (MsgRegisterEvent(&event, server_coid) == -1) {
        fail("MsgRegisterEvent", errno);
    }
    status = MsgSend(server_coid, &event, sizeof(event), NULL, 0);
    if (status == -1) {
        fail("MsgSend (event request)", errno);
    }
    if (status != 0) {
        fail("MsgSend (event request status)", EPROTO);
    }

    for (received = 0; received < EVENT_COUNT; ++received) {
        struct _pulse pulse = {0};
        if (MsgReceivePulse(notification_chid, &pulse,
                            sizeof(pulse), NULL) == -1) {
            fail("MsgReceivePulse", errno);
        }
        if (pulse.code != _PULSE_CODE_MINAVAIL ||
            pulse.value.sival_int != EVENT_VALUE) {
            fail("MsgReceivePulse (unexpected code or value)", EPROTO);
        }
    }
    if (MsgUnregisterEvent(&event) == -1) {
        fail("MsgUnregisterEvent", errno);
    }
    error = pthread_join(server, NULL);
    if (error != 0) {
        fail("pthread_join", error);
    }
    if (ConnectDetach(server_coid) == -1) {
        fail("ConnectDetach (server)", errno);
    }
    if (ConnectDetach(notification_coid) == -1) {
        fail("ConnectDetach (notifications)", errno);
    }
    if (ChannelDestroy(server_chid) == -1) {
        fail("ChannelDestroy (server)", errno);
    }
    if (ChannelDestroy(notification_chid) == -1) {
        fail("ChannelDestroy (notifications)", errno);
    }
    if (puts("QNX_EVENTS_OK delivered=3") == EOF ||
        puts("registered=1 verified=1") == EOF) {
        fail("puts", errno);
    }
    if (fflush(stdout) == EOF) {
        fail("fflush", errno);
    }
    return EXIT_SUCCESS;
}
