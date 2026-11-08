#include <sys/neutrino.h>
#include <pthread.h>
#include <sched.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { SERVER_PRIORITY = 10, REQUEST_COUNT = 2 };

struct server_context {
    int chid;
    int error;
};

struct client_context {
    int chid;
    int received;
    int error;
};

static int diagnose(const char *call, int error)
{
    fprintf(stderr, "prioinherit: %s: %s\n", call, strerror(error));
    return error;
}

/* Destroying a channel releases clients blocked on its messages.
 * EBADF is expected if another failure path already destroyed it.
 * No new channels are created during teardown. */
static int destroy_channel(int chid)
{
    if (ChannelDestroy(chid) == -1) {
        const int error = errno;
        if (error != EBADF) {
            return diagnose("ChannelDestroy", error);
        }
    }
    return 0;
}

static void *serve(void *argument)
{
    struct server_context *context = argument;
    int index;

    for (index = 0; index < REQUEST_COUNT; ++index) {
        struct sched_param param = {0};
        struct _msg_info info;
        union {
            struct _pulse pulse;
            int value;
        } request = {0};
        rcvid_t rcvid;
        int priority;

        rcvid = MsgReceive(context->chid, &request, sizeof(request), &info);
        if (rcvid == -1) {
            context->error = diagnose("MsgReceive", errno);
            break;
        }
        /* Observe the receiving thread before replying or doing other work. */
        if (SchedGet(0, 0, &param) == -1) {
            context->error = diagnose("SchedGet", errno);
            break;
        }
        priority = param.sched_curpriority;
        if (rcvid == 0 ||
            (size_t)info.srcmsglen != sizeof(request.value) ||
            (size_t)info.msglen != sizeof(request.value)) {
            context->error = diagnose("MsgReceive (unexpected request)", EPROTO);
            break;
        }
        if (MsgReply(rcvid, 0, &priority, sizeof(priority)) == -1) {
            context->error = diagnose("MsgReply", errno);
            break;
        }
    }
    if (context->error != 0) {
        /* Do not leave a client waiting for a reply from a failed server. */
        (void)destroy_channel(context->chid);
    }
    return NULL;
}

static void *request_priority(void *argument)
{
    struct client_context *context = argument;
    const int request = 1;
    int coid;
    long status;

    coid = ConnectAttach(0, 0, context->chid, _NTO_SIDE_CHANNEL, 0);
    if (coid == -1) {
        context->error = diagnose("ConnectAttach", errno);
        return NULL;
    }
    status = MsgSend(coid, &request, sizeof(request),
                     &context->received, sizeof(context->received));
    if (status == -1) {
        context->error = diagnose("MsgSend", errno);
    } else if (status != 0) {
        context->error = diagnose("MsgSend (unexpected status)", EPROTO);
    }
    if (ConnectDetach(coid) == -1) {
        context->error = diagnose("ConnectDetach", errno);
    }
    return NULL;
}

/* Track creation separately: attr destruction can fail after thread creation. */
static int start_thread(pthread_t *thread, int *started, int priority,
                        void *(*entry)(void *), void *argument)
{
    pthread_attr_t attributes;
    struct sched_param param = {0};
    const char *call;
    int error;
    int cleanup_error;

    *started = 0;
    error = pthread_attr_init(&attributes);
    if (error != 0) {
        return diagnose("pthread_attr_init", error);
    }
    call = "pthread_attr_setinheritsched";
    error = pthread_attr_setinheritsched(&attributes, PTHREAD_EXPLICIT_SCHED);
    if (error == 0) {
        call = "pthread_attr_setschedpolicy";
        error = pthread_attr_setschedpolicy(&attributes, SCHED_RR);
    }
    if (error == 0) {
        param.sched_priority = priority;
        call = "pthread_attr_setschedparam";
        error = pthread_attr_setschedparam(&attributes, &param);
    }
    if (error == 0) {
        call = "pthread_create";
        error = pthread_create(thread, &attributes, entry, argument);
        if (error == 0) {
            *started = 1;
        }
    }
    if (error != 0) {
        (void)diagnose(call, error);
    }
    cleanup_error = pthread_attr_destroy(&attributes);
    if (cleanup_error != 0) {
        (void)diagnose("pthread_attr_destroy", cleanup_error);
        if (error == 0) {
            error = cleanup_error;
        }
    }
    return error;
}

int main(void)
{
    struct server_context servers[2] = {{-1, 0}, {-1, 0}};
    struct client_context client = {-1, -1, 0};
    pthread_t server_threads[2];
    pthread_t client_thread;
    int server_started[2] = {0, 0};
    int client_started = 0;
    const int priorities[2] = {12, 20};
    int observed[2][2] = {{-1, -1}, {-1, -1}};
    int result = EXIT_FAILURE;
    int minimum;
    int maximum;
    int server_index;
    int client_index;
    int error;

    minimum = sched_get_priority_min(SCHED_RR);
    if (minimum == -1) {
        (void)diagnose("sched_get_priority_min", errno);
        goto cleanup;
    }
    maximum = sched_get_priority_max(SCHED_RR);
    if (maximum == -1) {
        (void)diagnose("sched_get_priority_max", errno);
        goto cleanup;
    }
    if (minimum > SERVER_PRIORITY || maximum < priorities[1]) {
        (void)diagnose("SCHED_RR (required priorities unavailable)", ERANGE);
        goto cleanup;
    }
    servers[0].chid = ChannelCreate(0);
    if (servers[0].chid == -1) {
        (void)diagnose("ChannelCreate (inherit)", errno);
        goto cleanup;
    }
    servers[1].chid = ChannelCreate(_NTO_CHF_FIXED_PRIORITY);
    if (servers[1].chid == -1) {
        (void)diagnose("ChannelCreate (fixed)", errno);
        goto cleanup;
    }
    for (server_index = 0; server_index < 2; ++server_index) {
        error = start_thread(&server_threads[server_index],
                             &server_started[server_index], SERVER_PRIORITY,
                             serve, &servers[server_index]);
        if (error != 0) {
            goto cleanup;
        }
    }
    for (server_index = 0; server_index < 2; ++server_index) {
        for (client_index = 0; client_index < 2; ++client_index) {
            client.chid = servers[server_index].chid;
            client.received = -1;
            client.error = 0;
            error = start_thread(&client_thread, &client_started,
                                 priorities[client_index], request_priority, &client);
            if (error != 0) {
                goto cleanup;
            }
            error = pthread_join(client_thread, NULL);
            if (error != 0) {
                (void)diagnose("pthread_join (client)", error);
                goto cleanup;
            }
            client_started = 0;
            if (client.error != 0) {
                goto cleanup;
            }
            observed[server_index][client_index] = client.received;
        }
    }
    if (observed[0][0] != 12 || observed[0][1] != 20 ||
        observed[1][0] != 10 || observed[1][1] != 10) {
        fprintf(stderr, "prioinherit: observed inherit=%d,%d fixed=%d,%d\n",
                observed[0][0], observed[0][1], observed[1][0], observed[1][1]);
        goto cleanup;
    }
    result = EXIT_SUCCESS;

cleanup:
    /* Destroy channels before joining on failure, releasing blocked threads.
     * On success all four replies have already completed. */
    for (server_index = 0; server_index < 2; ++server_index) {
        if (servers[server_index].chid != -1 &&
            destroy_channel(servers[server_index].chid) != 0) {
            result = EXIT_FAILURE;
        }
    }
    if (client_started) {
        error = pthread_join(client_thread, NULL);
        if (error != 0) {
            (void)diagnose("pthread_join (client cleanup)", error);
        }
        result = EXIT_FAILURE;
    }
    for (server_index = 0; server_index < 2; ++server_index) {
        if (server_started[server_index]) {
            error = pthread_join(server_threads[server_index], NULL);
            if (error != 0) {
                (void)diagnose("pthread_join (server)", error);
                result = EXIT_FAILURE;
            } else if (servers[server_index].error != 0) {
                result = EXIT_FAILURE;
            }
        }
    }
    if (result == EXIT_SUCCESS) {
        if (puts("QNX_PRIO_INHERIT_OK received_at=12,20") == EOF ||
            puts("QNX_PRIO_FIXED_OK received_at=10,10") == EOF) {
            (void)diagnose("puts", errno);
            result = EXIT_FAILURE;
        }
        if (fflush(stdout) == EOF) {
            (void)diagnose("fflush", errno);
            result = EXIT_FAILURE;
        }
    }
    return result;
}
