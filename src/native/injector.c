#define _GNU_SOURCE

#include <libweston-15/libweston/libweston.h>
#include <wayland-server.h>
#include <linux/input-event-codes.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#ifndef WESTON_KEY_STATE_UPDATE_AUTOMATIC
#define WESTON_KEY_STATE_UPDATE_AUTOMATIC STATE_UPDATE_AUTOMATIC
#endif

/* Forward declarations for Weston internal/exported symbols */
void weston_seat_init(struct weston_seat *seat, struct weston_compositor *ec, const char *seat_name);
int weston_seat_init_pointer(struct weston_seat *seat);
int weston_seat_init_keyboard(struct weston_seat *seat, const struct xkb_keymap *keymap);

void notify_motion_absolute(struct weston_seat *seat, const struct timespec *time, double x, double y);
void notify_button(struct weston_seat *seat, const struct timespec *time, int32_t button, enum wl_pointer_button_state state);
void notify_key(struct weston_seat *seat, const struct timespec *time, uint32_t key, enum wl_keyboard_key_state state, enum weston_key_state_update update_state);
void notify_axis(struct weston_seat *seat, const struct timespec *time, struct weston_pointer_axis_event *event);
void notify_pointer_frame(struct weston_seat *seat);

struct injector_server;

struct injector_client {
	int fd;
	struct wl_event_source *source;
	struct injector_server *server;
	char buf[4096];
	size_t len;
	struct wl_list link;
};

struct injector_server {
	struct weston_compositor *compositor;
	struct weston_seat *seat;
	int server_fd;
	struct wl_event_source *server_source;
	char sock_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
	struct wl_list clients;
	struct wl_listener destroy_listener;
};

static struct weston_seat custom_seat;

static ssize_t send_all(int fd, const void *buf, size_t len)
{
	size_t total = 0;
	const char *p = (const char *)buf;

	while (total < len) {
		ssize_t ret = send(fd, p + total, len - total, MSG_NOSIGNAL);
		if (ret < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				break;
			return -1;
		}
		if (ret == 0)
			break;
		total += (size_t)ret;
	}
	return (ssize_t)total;
}

static void destroy_client(struct injector_client *client)
{
	if (!client)
		return;

	if (client->source) {
		wl_event_source_remove(client->source);
		client->source = NULL;
	}

	if (client->fd >= 0) {
		close(client->fd);
		client->fd = -1;
	}

	wl_list_remove(&client->link);
	free(client);
}

static void process_command(struct injector_client *client, const char *cmd)
{
	struct injector_server *srv = client->server;
	struct weston_seat *seat = srv->seat;
	struct timespec now;

	weston_compositor_get_time(&now);

	if (strncmp(cmd, "MOVE ", 5) == 0) {
		double x = 0.0, y = 0.0;
		if (sscanf(cmd + 5, "%lf %lf", &x, &y) == 2) {
			notify_motion_absolute(seat, &now, x, y);
			notify_pointer_frame(seat);
		}
	} else if (strncmp(cmd, "BUTTON ", 7) == 0) {
		uint32_t button = 0, state = 0;
		if (sscanf(cmd + 7, "%u %u", &button, &state) == 2) {
			notify_button(seat, &now, (int32_t)button, (enum wl_pointer_button_state)state);
			notify_pointer_frame(seat);
		}
	} else if (strncmp(cmd, "KEY ", 4) == 0) {
		uint32_t key = 0, state = 0;
		if (sscanf(cmd + 4, "%u %u", &key, &state) == 2) {
			notify_key(seat, &now, key, (enum wl_keyboard_key_state)state, WESTON_KEY_STATE_UPDATE_AUTOMATIC);
		}
	} else if (strncmp(cmd, "AXIS ", 5) == 0) {
		uint32_t axis = 0;
		double val = 0.0;
		if (sscanf(cmd + 5, "%u %lf", &axis, &val) == 2) {
			struct weston_pointer_axis_event ev = {
				.axis = axis,
				.value = val,
				.has_discrete = false,
				.discrete = 0
			};
			notify_axis(seat, &now, &ev);
			notify_pointer_frame(seat);
		}
	} else if (strcmp(cmd, "FRAME") == 0) {
		notify_pointer_frame(seat);
	} else if (strcmp(cmd, "PING") == 0) {
		const char pong[] = "PONG\n";
		send_all(client->fd, pong, sizeof(pong) - 1);
	} else if (strcmp(cmd, "INFO") == 0) {
		int width = 0, height = 0;
		if (!wl_list_empty(&srv->compositor->output_list)) {
			struct weston_output *output = wl_container_of(srv->compositor->output_list.next, output, link);
			width = output->width;
			height = output->height;
		}
		char reply[128];
		int n = snprintf(reply, sizeof(reply), "OK width=%d height=%d\n", width, height);
		if (n > 0) {
			send_all(client->fd, reply, (size_t)n);
		}
	}
}

static int on_client_data(int fd, uint32_t mask, void *data)
{
	(void)fd;
	struct injector_client *client = (struct injector_client *)data;

	if (mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR)) {
		destroy_client(client);
		return 0;
	}

	if (mask & WL_EVENT_READABLE) {
		ssize_t n = recv(client->fd, client->buf + client->len, sizeof(client->buf) - 1 - client->len, 0);
		if (n <= 0) {
			if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
				return 0;
			destroy_client(client);
			return 0;
		}

		client->len += (size_t)n;
		client->buf[client->len] = '\0';

		char *newline;
		while ((newline = (char *)memchr(client->buf, '\n', client->len)) != NULL) {
			*newline = '\0';
			size_t line_len = (size_t)(newline - client->buf);
			if (line_len > 0 && client->buf[line_len - 1] == '\r') {
				client->buf[line_len - 1] = '\0';
			}

			process_command(client, client->buf);

			size_t consumed = line_len + 1;
			size_t remaining = client->len - consumed;
			if (remaining > 0) {
				memmove(client->buf, newline + 1, remaining);
			}
			client->len = remaining;
			client->buf[client->len] = '\0';
		}

		if (client->len >= sizeof(client->buf) - 1) {
			/* Line exceeds buffer capacity without newline; flush to prevent buffer stall */
			client->len = 0;
			client->buf[0] = '\0';
		}
	}

	return 0;
}

static int on_client_connect(int fd, uint32_t mask, void *data)
{
	(void)mask;
	struct injector_server *srv = (struct injector_server *)data;

	int client_fd = accept4(fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
	if (client_fd < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
			return 0;
		return 0;
	}

	struct injector_client *client = (struct injector_client *)calloc(1, sizeof(*client));
	if (!client) {
		close(client_fd);
		return 0;
	}

	client->fd = client_fd;
	client->server = srv;
	client->len = 0;
	wl_list_insert(&srv->clients, &client->link);

	struct wl_event_loop *loop = wl_display_get_event_loop(srv->compositor->wl_display);
	client->source = wl_event_loop_add_fd(loop, client_fd,
	                                      WL_EVENT_READABLE | WL_EVENT_HANGUP | WL_EVENT_ERROR,
	                                      on_client_data, client);
	if (!client->source) {
		destroy_client(client);
		return 0;
	}

	return 0;
}

static void compositor_destroy_listener(struct wl_listener *listener, void *data)
{
	(void)data;
	struct injector_server *srv = wl_container_of(listener, srv, destroy_listener);

	struct injector_client *client, *tmp;
	wl_list_for_each_safe(client, tmp, &srv->clients, link) {
		destroy_client(client);
	}

	if (srv->server_source) {
		wl_event_source_remove(srv->server_source);
		srv->server_source = NULL;
	}

	if (srv->server_fd >= 0) {
		close(srv->server_fd);
		srv->server_fd = -1;
	}

	if (srv->sock_path[0] != '\0') {
		unlink(srv->sock_path);
		srv->sock_path[0] = '\0';
	}

	wl_list_remove(&srv->destroy_listener.link);
	free(srv);
}

WL_EXPORT int wet_module_init(struct weston_compositor *ec, int *argc, char *argv[])
{
	(void)argc;
	(void)argv;

	if (!ec)
		return -1;

	struct weston_seat *seat = NULL;
	if (!wl_list_empty(&ec->seat_list)) {
		seat = wl_container_of(ec->seat_list.next, seat, link);
	} else {
		weston_seat_init(&custom_seat, ec, "cua-seat");
		seat = &custom_seat;
	}

	if (!weston_seat_get_pointer(seat))
		weston_seat_init_pointer(seat);
	if (!weston_seat_get_keyboard(seat))
		weston_seat_init_keyboard(seat, NULL);

	const char *env_sock = getenv("WSTN_CUA_SOCK");
	char sock_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
	if (env_sock && env_sock[0] != '\0') {
		snprintf(sock_path, sizeof(sock_path), "%s", env_sock);
	} else {
		snprintf(sock_path, sizeof(sock_path), "/tmp/wstn-cua-%d.sock", (int)getpid());
	}

	unlink(sock_path);

	int server_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
	if (server_fd < 0) {
		fprintf(stderr, "[wstn-injector] Failed to create socket: %s\n", strerror(errno));
		return -1;
	}

	struct sockaddr_un addr;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path);

	if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		fprintf(stderr, "[wstn-injector] Failed to bind socket %s: %s\n", sock_path, strerror(errno));
		close(server_fd);
		return -1;
	}

	if (listen(server_fd, 16) < 0) {
		fprintf(stderr, "[wstn-injector] Failed to listen on socket %s: %s\n", sock_path, strerror(errno));
		unlink(sock_path);
		close(server_fd);
		return -1;
	}

	struct injector_server *srv = (struct injector_server *)calloc(1, sizeof(*srv));
	if (!srv) {
		unlink(sock_path);
		close(server_fd);
		return -1;
	}

	srv->compositor = ec;
	srv->seat = seat;
	srv->server_fd = server_fd;
	snprintf(srv->sock_path, sizeof(srv->sock_path), "%s", sock_path);
	wl_list_init(&srv->clients);

	struct wl_event_loop *loop = wl_display_get_event_loop(ec->wl_display);
	srv->server_source = wl_event_loop_add_fd(loop, server_fd, WL_EVENT_READABLE, on_client_connect, srv);
	if (!srv->server_source) {
		fprintf(stderr, "[wstn-injector] Failed to add server fd to event loop\n");
		unlink(sock_path);
		close(server_fd);
		free(srv);
		return -1;
	}

	srv->destroy_listener.notify = compositor_destroy_listener;
	wl_signal_add(&ec->destroy_signal, &srv->destroy_listener);

	fprintf(stderr, "[wstn-injector] Initialized successfully, listening on %s\n", sock_path);
	return 0;
}
