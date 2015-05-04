var AMQPClient  = require('../lib/amqp_client');

var uri = 'amqp://localhost/random4';

var client = new AMQPClient(uri, function () {
  var totalRx = 0;
  client.receive(function (err, payload, annotations) {
       if (err) {
           console.log('ERROR: ');
           console.log(err);
       } else {
           console.log('Recv: ');
           console.log(payload);
           if (annotations) {
               console.log('Annotations:');
               console.log(annotations);
           }
           console.log('');
           try {
             ++totalRx;
             if (totalRx === 1000) {
               client.disconnect(function () {
                   console.log("Received expected number of messages.  Disconnected.");
               });
             }
           } catch (e) {
               console.log("Error parsing payload " + payload);
               console.log(e);
           }
       }
  });
});
