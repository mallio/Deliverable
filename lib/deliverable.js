(function(){
  var ACTIVE_CONNECTIONS, ACTIVE_DELIVERIES, Delivery, DeliveryAttempt, FAILED_DELIVERIES, MAX_ATTEMPTS, MAX_CONNECTIONS, RETRY_DELAY, SERVER_PORT, SUCCESSFUL_DELIVERIES, TOTAL_DELIVERIES, TOTAL_DELIVERY_ATTEMPTS, deliveryRequest, http, server, statsRequest, sys, url;
  sys = require('sys');
  http = require('http');
  url = require('url');
  querystring = require('querystring');
  MAX_ATTEMPTS = 5;
  RETRY_DELAY = 5 * 1000;
  SERVER_PORT = 5678;
  MAX_CONNECTIONS = 1024;
  ACTIVE_CONNECTIONS = 0;
  TOTAL_DELIVERIES = 0;
  ACTIVE_DELIVERIES = 0;
  SUCCESSFUL_DELIVERIES = 0;
  FAILED_DELIVERIES = 0;
  TOTAL_DELIVERY_ATTEMPTS = 0;
  url.fullPath = function fullPath(uri) {
    var path;
    path = '';
    uri.pathname ? path += uri.pathname : path += '/';
    if (uri.query && uri.query !== '') {
      path += '?' + uri.query;
    }
    return path;
  };
  Delivery = function Delivery(endpoint, request) {
    TOTAL_DELIVERIES++;
    ACTIVE_DELIVERIES++;
    this.id = TOTAL_DELIVERIES;
    this.request = request;
    this.attemptCount = 0;
    this.successful = null;
    this.endpoint = null;
    this.callback = null;
    this.errback = null;
    this.endpoint = url.parse(endpoint);
    if (request.headers['x-deliverable-callback']) {
      this.callback = url.parse(request.headers['x-deliverable-callback']);
    }
    if (request.headers['x-deliverable-errback']) {
      this.errback = url.parse(request.headers['x-deliverable-errback']);
    }
    this.log("Delivery Request Received: " + this.endpoint.href);
    this.deliver();
    return this;
  };
  Delivery.prototype.deliver = function deliver() {
    this.attemptCount++;
    this.log("Atempting Delivery (" + this.attemptCount + ")");
    return new DeliveryAttempt(this).deliver((function(__this) {
      var __func = function(delivered, res) {
        return this.attemptComplete(delivered, res);
      };
      return (function() {
        return __func.apply(__this, arguments);
      });
    })(this));
  };
  Delivery.prototype.attemptComplete = function attemptComplete(delivered, res) {
    this.log("Attempt Completed (" + this.attemptCount + ")");
    if (delivered) {
      return this.registerSuccess();
    }
    return this.attemptCount === MAX_ATTEMPTS ? this.registerFailure(res) : setTimeout(((function(__this) {
      var __func = function() {
        return this.deliver();
      };
      return (function() {
        return __func.apply(__this, arguments);
      });
    })(this)), (this.attemptCount * this.attemptCount) * RETRY_DELAY);
  };
  Delivery.prototype.registerSuccess = function registerSuccess() {
    this.successful = true;
    this.log("Delivery Successful (after " + this.attemptCount + " attempts)");
    SUCCESSFUL_DELIVERIES++;
    ACTIVE_DELIVERIES--;
    if (this.callback) {
      return this.makeCallbackRequest(this.callback);
    }
  };
  Delivery.prototype.registerFailure = function registerFailure(res) {
    this.successful = false;
    this.log("Delivery Failed Given Up (after " + this.attemptCount + " attempts)");
    FAILED_DELIVERIES++;
    ACTIVE_DELIVERIES--;
    if (this.errback) {
      return this.makeCallbackRequest(this.errback, res);
    }
  };
  Delivery.prototype.makeCallbackRequest = function makeCallbackRequest(uri, res) {
    var client, request;
    this.log("Running Callback: " + uri.href);
    try {
      var data = res ? {
        request: res.requestBody,
        status: res.statusCode,
        headers: JSON.stringify(res.headers),
        body: res.body
      } : null;
      var dataStr = data ? querystring.stringify(data) : '';
      client = http.createClient(uri.port || 80, uri.hostname);
      request = client.request('POST', url.fullPath(uri),
        {'host': uri.hostname, 'content-length' : dataStr.length});
      data && request.write(dataStr);
      request.addListener('response', (function(__this) {
        var __func = function(res) {
          return this.log("Callback Successful: " + uri.href);
        };
        return (function() {
          return __func.apply(__this, arguments);
        });
      })(this));
      return request.end();
    } catch (e) {
      return this.log("Callback Failed: " + uri.href);
    }
  };
  Delivery.prototype.log = function log(msg) {
    return sys.log('[' + this.id + ']\t' + msg);
  };
  DeliveryAttempt = function DeliveryAttempt(delivery) {
    TOTAL_DELIVERY_ATTEMPTS++;
    this.delivery = delivery;
    this.method = delivery.request.method;
    this.headers = delivery.request.headers;
    this.body = delivery.request.body;
    this.endpoint = delivery.endpoint;
    this.cleanHeaders();
    return this;
  };
  DeliveryAttempt.prototype.deliver = function deliver(callback) {
    var client, request;
    if (ACTIVE_CONNECTIONS >= MAX_CONNECTIONS) {
      this.delivery.log('Waiting for a spare connection');
      setTimeout(((function(__this) {
        var __func = function() {
          return this.deliver(callback);
        };
        return (function() {
          return __func.apply(__this, arguments);
        });
      })(this)), 100);
      return null;
    }
    ACTIVE_CONNECTIONS++;
    try {
      var requestBody = this.body;
      var ssl = this.endpoint.protocol == 'https:';
      var defaultPort = ssl ? 443 : 80;
      client = http.createClient(this.endpoint.port || defaultPort, this.endpoint.hostname, ssl);
      request = client.request(this.method, url.fullPath(this.endpoint), this.headers);
      request.write(this.body);
      request.addListener('response', function(res) {
        var body = "";
        res.addListener('data', function(chunk){body += chunk});
        return res.addListener('end', function() {
          res.requestBody = requestBody;
          res.body = body;
          callback(res.statusCode < 400, res);
          return ACTIVE_CONNECTIONS--;
        });
      });
      client.addListener('error', function(e) {
        res = {headers:{}, requestBody: requestBody, body: e.message, statusCode: 0};
        callback(false, res);
        return ACTIVE_CONNECTIONS--;
      });
      return request.end();
    } catch (e) {
      res = {headers:{}, requestBody: '', body: '', statusCode: 0};
      ACTIVE_CONNECTIONS--;
      return callback(false, res);
    }
  };
  DeliveryAttempt.prototype.cleanHeaders = function cleanHeaders() {
    this.headers['x-deliverable-endpoint'] = null;
    this.headers['x-deliverable-errback'] = null;
    return this.headers['x-deliverable-callback'] = null;
  };
  deliveryRequest = function deliveryRequest(request, response) {
    var message;
    if (request.headers['x-deliverable-endpoint']) {
      request.headers['x-deliverable-endpoint'].split('; ').forEach(function(endpoint) {
        return new Delivery(endpoint, request);
      });
      response.writeHead(200, {
        'Content-Type': 'text/plain'
      });
      response.write('ACCEPTED');
    } else {
      message = 'Request Ignored - no X-Deliverable-Endpoint header was given.';
      response.writeHead(412, {
        'Content-Type': 'text/plain'
      });
      response.write(message);
      sys.log(message);
    }
    return response.end();
  };
  statsRequest = function statsRequest(request, response) {
    response.writeHead(200, {
      'Content-Type': 'text/plain'
    });
    response.write(JSON.stringify({
      MAX_ATTEMPTS: MAX_ATTEMPTS,
      RETRY_DELAY: RETRY_DELAY,
      TOTAL_DELIVERIES: TOTAL_DELIVERIES,
      ACTIVE_DELIVERIES: ACTIVE_DELIVERIES,
      SUCCESSFUL_DELIVERIES: SUCCESSFUL_DELIVERIES,
      FAILED_DELIVERIES: FAILED_DELIVERIES,
      TOTAL_DELIVERY_ATTEMPTS: TOTAL_DELIVERY_ATTEMPTS
    }));
    return response.end();
  };
  server = http.createServer(function(request, response) {
    request.body = '';
    request.addListener('data', function(data) {
      return request.body += data;
    });
    return request.addListener('end', function(data) {
      return request.url.search(/^\/deliver/) >= 0 ? deliveryRequest(request, response) : statsRequest(request, response);
    });
  });
  exports.start = function start() {
    return server.listen(SERVER_PORT);
  };
  exports.stop = function stop() {
    return server.close();
  };
})();
