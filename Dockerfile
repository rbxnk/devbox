FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server mosh locales ca-certificates curl git build-essential \
      less procps ripgrep unzip \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && echo LANG=en_US.UTF-8 > /etc/default/locale \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /etc/ssh/keys /etc/ssh/authorized_keys \
 && rm -f /etc/ssh/ssh_host_*
ENV LANG=en_US.UTF-8

# mise for languages and CLIs. The binary is in the image (update it by rebuilding);
# the tools it installs live in dev's home volume. Shims on PATH also cover
# non-interactive shells, such as the commands agents run.
RUN curl -fsSL https://mise.run -o /tmp/mise.sh \
 && MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/mise.sh && rm /tmp/mise.sh \
 && mise --version \
 && echo 'export PATH="$HOME/.local/share/mise/shims:$PATH"' > /etc/profile.d/mise.sh

# No password and no sudo: agents can't get root or undo anything set up as root.
# '*' rather than the default '!' so sshd doesn't treat the account as locked.
RUN useradd -m -s /bin/bash dev && usermod -p '*' dev

COPY sshd.conf /etc/ssh/sshd_config.d/devbox.conf
COPY entrypoint.sh check.sh /usr/local/bin/

EXPOSE 22 60000-60010/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
