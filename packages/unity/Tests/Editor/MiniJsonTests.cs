using System.Collections.Generic;
using NUnit.Framework;

namespace RezonaLab.EngineBridge.Editor.Tests
{
    public sealed class MiniJsonTests
    {
        [Test]
        public void ParsesNestedAndRoundTripsInOrder()
        {
            var text = "{\"type\":\"hello_ack\",\"protocol\":1,\"project\":{\"name\":\"A\",\"id\":\"b3\"},\"formats\":[\"glb\",\"png\"],\"ok\":true,\"x\":null,\"f\":1.5}";
            var o = (JsonObject)MiniJson.Parse(text);
            Assert.AreEqual("hello_ack", o["type"]);
            Assert.AreEqual(1.0, o["protocol"]);
            Assert.AreEqual("b3", ((JsonObject)o["project"])["id"]);
            Assert.AreEqual(2, ((List<object>)o["formats"]).Count);
            Assert.AreEqual(true, o["ok"]);
            Assert.IsNull(o["x"]);
            Assert.AreEqual(text, MiniJson.Serialize(o));
        }

        [Test]
        public void EscapesAndUnescapesStrings()
        {
            var o = (JsonObject)MiniJson.Parse("{\"s\":\"a\\\"b\\\\c\\n\\u4e2d\"}");
            Assert.AreEqual("a\"b\\c\n中", o["s"]);
            Assert.AreEqual("{\"s\":\"a\\\"b\\\\c\\n中\"}", MiniJson.Serialize(o));
        }

        [Test]
        public void RejectsMalformed()
        {
            Assert.Throws<System.FormatException>(() => MiniJson.Parse("{\"a\":}"));
            Assert.Throws<System.FormatException>(() => MiniJson.Parse("[1,]"));
            Assert.Throws<System.FormatException>(() => MiniJson.Parse("{} x"));
        }

        [Test]
        public void IntegerDetectionMatchesJsonSchema()
        {
            Assert.IsTrue(MiniJson.IsInteger(MiniJson.Parse("5.0")));
            Assert.IsFalse(MiniJson.IsInteger(MiniJson.Parse("5.5")));
            Assert.IsFalse(MiniJson.IsInteger("5"));
        }

        [Test]
        public void CanonicalSortsKeys()
        {
            Assert.AreEqual(MiniJson.Canonical(MiniJson.Parse("{\"b\":1,\"a\":[{\"y\":0,\"x\":0}]}")), MiniJson.Canonical(MiniJson.Parse("{\"a\":[{\"x\":0,\"y\":0}],\"b\":1}")));
        }
    }
}
