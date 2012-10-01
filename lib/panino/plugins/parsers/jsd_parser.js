/** internal, section: Plugins
 *  Parsers.panino(Panino) -> Void
 *
 *  Registers Panino parser as `panino`.
 *
 *
 *  ##### Example
 *
 *      Panino.parse(files, options, function (err, ast) {
 *        // ...
 *      });
 **/


'use strict';


// stdlib
var fs = require('fs');
var util = require('util');

// 3rd-party
var _ = require('underscore');
var esprima = require('esprima');

// internal
var Panino = require(__dirname + '/../../../panino');
var JSParser = require("./javascript/jsd/js_parser");
var ASTEsprima = require("./javascript/jsd/ast_esprima");
var DocParser = require("./javascript/jsd/doc_parser");
var DocType = require("./javascript/jsd/doc_type");
var DocExpander = require("./javascript/jsd/doc_expander");
var DocAst = require("./javascript/jsd/doc_ast");
var Merger = require("./javascript/jsd/merger");

var doc_ast;

////////////////////////////////////////////////////////////////////////////////

function parse_javascript(file, options, callback) { 
  fs.readFile(file, 'utf8', function (err, source) {
    if (err) {
      callback(err);
      return;
    }
    process_jsd(source, file, options, callback);
  });
}

var process_jsd = function(source, file, options, callback) {
  var nodes = {}, remainingNodes, ast, docs, expanded, merged, classPrefix, list = {}, tree, parted, sections, children;
  doc_ast = new DocAst();

  // start parsing a la JSDuck
  try {
    ast = esprima.parse(source, {comment: true, range: true, raw: true});

    docs = JSParser.parse(ast, source);
    
    docs = new ASTEsprima(docs, options).detect_all();
    merged = _.chain(docs).map(function(docset) {
      return expand(docset);
    }).flatten().map(function (docset) {
      return merge(docset);
    }).value();

  } catch (err) {
    console.error("FATAL".red + ": problem parsing", file, err);
    callback(err);
    return;
  }


   // _.each(merged, function(m) {
   //   console.log("merged", m)
   // });

  // start formatting to match "classic" ndoc/panino style; if I were smarter I
  // would just do this above, during the parsing

  // grab the class name out (if it exists)
  remainingNodes = _.reject(merged, function(i) {
    if (i["tagname"] === "class" && i["doc"] !== undefined) {
      classPrefix = i["name"];
      nodes[classPrefix] = createBasicTranslation(classPrefix, "class", i, merged);

      if (i["inherits"] !== undefined && i["inherits"].length > 0) 
        nodes[classPrefix]["inherits"] = i["inherits"];

      if (i["allowchild"] !== undefined) 
        nodes[classPrefix]["allowchild"] = i["allowchild"].doc;

      if (i["define"] !== undefined) 
        nodes[classPrefix]["define"] = i["define"].doc;

      return true;
    }
  });

  // esprima parsing is good--too good! remove nodes that just don't have doc,
  // or, remove nodes that just contain "@todo" in the beginning
  remainingNodes = _.filter(remainingNodes, function(i) {
    if (i["doc"] !== undefined && !/^@todo/i.test(i["doc"]))
      return true;
    else if (i["inheritdoc"] !== undefined)
      return true;
    else {
       // console.log(i)
    }
  });

  remainingNodes = _.reject(remainingNodes, function(i) {
    var isEvent = i["tagname"] == "event";
    var joinChar = isEvent ? "@" : ".";

    if (classPrefix === undefined && options.globalNS) 
      classPrefix = options.globalNS;
    else if (options.globalNS === undefined)
      joinChar = "";

    
    var memberName = [classPrefix, i["name"]].join(joinChar);
    if (memberName.lastIndexOf(".") === memberName.length - 1 && i["inheritdoc"] === undefined) {
      console.error(i);    
      console.error("FATAL".red + ": this object doesn't have a proper name. Check that your comment is written correctly. Typically, his happens when: ");
      console.error("       * A statement above is missing a semicolon--including closing function tags--see this bug: " + "http://code.google.com/p/esprima/issues/detail?id=347&thanks=347&ts=1348621099".cyan);
      console.error("       * The line above a comment is a single line comment--see this bug: " + "https://github.com/senchalabs/jsduck/issues/247".cyan);
      process.exit(1)
    }
    
    if (i["tagname"] === "method" || isEvent) {
      nodes[memberName] = createBasicTranslation(memberName, isEvent ? "event": "method", i, remainingNodes);
      nodes[memberName]["signatures"] = [];
      var ret = {};

      // these next blocks don't yet handle alternate signatures...
      // but are written as if they will :)
      if (i["params"] !== undefined) {
          var sig = { "arguments": [] };
          nodes[memberName]["arguments"] = [];

          _.each(i["params"], function(p) {
            // construct the args object
            var args = {};
            args.name = p["name"];
            args.description = p["doc"];
            args.types = [];

            // types could be multiple
            if (p["type"].indexOf("|") >= 0) {
              p["type"].split("|").forEach(function(t) {
                args.types.push(trim(t));
              });
            }
            else if (p["type"].indexOf(",") >= 0) {
              console.warn("WARNING".yellow + ": you're using ',' to separate types in " + memberName + ", use '|' instead.");
            }
            else {
              args.types.push(p["type"]);
            }

            args.optional = p["optional"];

            sig.arguments.push(args);

            // somewhat confusing...there are args on "signatures" and a separate arguments property
            nodes[memberName]["arguments"].push(args);
          });
      }

      if (i["return"] !== undefined) {
        if (i["return"].type.indexOf("[") == 0) { // TODO: probably not best to do this here
          ret.type = i["return"].type.substr(1, i["return"].type.length - 2);
          ret.isArray = true;
        }
        else {
          ret.type = i["return"].type;
        }
        ret.description = i["return"].description;
      }

      nodes[memberName]["signatures"].push({"arguments": nodes[memberName]["arguments"], "return": ret});

      if (isEvent) {
        if (i["cancelable"] !== undefined)
          nodes[memberName]["cancelable"] = i["cancelable"];
        if (i["bubbles"] !== undefined)
          nodes[memberName]["bubbles"] = i["bubbles"];
      }
      return true;
    }

    else if (i["tagname"] === "property") {
      nodes[memberName] = createBasicTranslation(memberName, "property", i, remainingNodes);
      nodes[memberName]["signatures"] = [ { arguments: undefined, returns: [ { type: i["type"] } ] } ];
      return true;
    }

    else if (i["tagname"] === "attribute") {
      nodes[memberName] = createBasicTranslation(memberName, "attribute", i, remainingNodes);
      nodes[memberName]["signatures"] = [ { arguments: undefined, returns: [ { type: i["type"] } ] } ];
      return true;
    }

    else if (i["tagname"] === "binding") {
      nodes[memberName] = createBasicTranslation(memberName, "binding", i, remainingNodes);
      nodes[memberName]["signatures"] = [ { arguments: undefined, returns: [ { type: i["type"] } ] } ];
      return true;
    }

    else {
      console.warn("Warning".yellow + ": I don't know what " + i["tagname"] + " is supposed to do in " + file);
      return true;
    }
  });

  // do pre-distribute early work
  _.each(nodes, function (node, id) {
    var clone;

    // assign hierarchy helpers
    node.aliases  = [];
    node.children = [];

    // set source file of the node
    node.file = file;

    if ('class' === node.type) {
      node.subclasses = [];
    }

    // collect sections
    if ('section' === node.type) {
      list[node.id] = node;
      return;
    }

    // elements with undefined section get '' section,
    // and will be resolved later, when we'll have full
    // element list
    list[(node.section || '') + '.' + node.id] = node;

    // bound methods produce two methods with the same description but different signatures
    // E.g. Element.foo(@element, a, b) becomes
    // Element.foo(element, a, b) and Element#foo(a, b)
    if ('method' === node.type && node.bound) {
      clone = _.clone(node);
      clone.id = node.id.replace(/(.+)\.(.+)$/, '$1#$2');

      // link to methods
      node.bound = clone.id;
      clone.bound = node.id;

      // insert bound method clone
      list[(node.section || '') + '.' + clone.id] = clone;
    }
  });

  // TODO: section.related_to should mark related element as belonging to the section
  //_.each(list, function (node, id) {
  //  var ref_id = '.' + node.related_to, ref;
  //  if ('section' === node.type && node.related_to && list[ref_id]) {
  //    ref = list[ref_id];
  //    ref.id = node.id + '.' + node.related_to;
  //    delete list[ref_id];
  //    list[ref.id] = ref;
  //  }
  //});

  callback(null, list);
}

// Parses the docs, detects tagname and expands class docset
function expand(docset) {
    docset["comment"] = DocParser.parse(docset["comment"]);
    docset["tagname"] = DocType.detect(docset["comment"], docset["code"]);

    if (docset["tagname"] == "class")
      return DocExpander.expand(docset);
    else
      return docset;
}

// Merges comment and code parts of docset
function merge(docset) {
  doc_ast.linenr = docset["linenr"];
  docset["comment"] = doc_ast.detect(docset["tagname"], docset["comment"]);
  
  return Merger.merge(docset);
}

// creates types for nodes that can be anything
function createBasicTranslation(memberName, type, i) {
  var node = {};

  node["id"] = memberName;
  node["type"] = type;

  if (i["inheritdoc"] !== undefined) {
    node["inheritdoc"] = i["inheritdoc"].src;
  }
  else {
    node["description"] = i["doc"];

    // short description lasts until the first empty line
    node["short_description"] = node["description"].replace(/\n\n[\s\S]*$/, '\n');
  }

  node["line"] = i["linenr"];

  if (i["private"] !== undefined)
    node["private"] = i["private"];

  if (i["experimental"] !== undefined)
    node["experimental"] = i["experimental"];

  if (i["chainable"] !== undefined)
    node["chainable"] = i["chainable"];

  if (i["see"] !== undefined)
    node["related_to"] = i["see"].name;

  if (i["author"] !== undefined && i["author"].length > 0)
    node["author"] = i["author"].doc;
  
  if (i["version"] !== undefined)
    node["version"] = i["version"].doc;
  
  if (i["since"] !== undefined)
    node["since"] = i["since"].doc;


  return node;
}

function trim (str) {
  return str.replace(/^ +| +$/g, '');
}

////////////////////////////////////////////////////////////////////////////////


module.exports = function (PaninoArg, args) {
  PaninoArg.registerParser('.js', parse_javascript);
};