/*global UIkit, Vue */


(() => {
  
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  
  const notification = (config) =>
    UIkit.notification({
      pos: "top-right",
      timeout: 5000,
      ...config,
    });
  
  const alert = (message) =>
    notification({
      message,
      status: "danger",
    });
  
  const info = (message) =>
    notification({
      message,
      status: "success",
    });
  
  
  new Vue({
    el: "#app",
    data: {
      desc: "",
      activeTimers: [],
      oldTimers: [],
      client: new WebSocket(`${wsProtocol}//${location.host}?token=${TOKEN}`)
    },
    methods: {
      waitForConnection(callback, interval){
        if (this.client.readyState === 1) {
          callback();
        } else {
          const that = this;
          setTimeout(() => {
            that.waitForConnection(callback, interval);
          }, interval);
        }
      },
      wsSend(msg){
        this.waitForConnection(() => {
          this.client.send(JSON.stringify(msg));
        }, 1000);
      },
      wsMessage(msg){
        try {
          msg = JSON.parse(msg.data);
        }
        catch (e) {
          console.log(e);
          alert("WebSocket error")
        }
        console.log(msg);
  
        switch (msg.type) {
          case 'add_timer':
            info(`Created new timer "${msg.description}" [${msg.id}]`);
            this.wsSend({type: 'all_timers'});
            break;
          case 'stop_timer':
            info(`Stopped the timer [${msg.id}]`);
            this.wsSend({type: 'all_timers'});
            break;
          case 'active_timers':
            this.activeTimers = msg.activeTimers;
            break;
          case 'old_timers':
            this.oldTimers = msg.oldTimers;
            break;
          default:
            break;
        }
      },
      createTimer() {
        const description = this.desc;
        this.desc = "";
        this.wsSend({type: 'add_timer', description});
      },
      stopTimer(id) {
        this.wsSend({type: 'stop_timer', id});
      },
      formatTime(ts) {
        return new Date(ts).toTimeString().split(" ")[0];
      },
      formatDuration(d) {
        d = Math.floor(d / 1000);
        const s = d % 60;
        d = Math.floor(d / 60);
        const m = d % 60;
        const h = Math.floor(d / 60);
        return [h > 0 ? h : null, m, s]
          .filter((x) => x !== null)
          .map((x) => (x < 10 ? "0" : "") + x)
          .join(":");
      },
    },
    created() {
      
      this.client.onmessage = (msg) => this.wsMessage(msg);
  
      this.wsSend({type: 'all_timers'});
      
      setInterval(() => {
        this.wsSend({type: 'active_timers'});
      }, 1000);
    },
  });
})();
